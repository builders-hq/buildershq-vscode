import * as vscode from 'vscode';
import { execFile } from 'child_process';

export interface GitHubPrEvent {
  timestamp: number;
  eventType: 'pr_opened' | 'pr_merged' | 'pr_closed';
  prNumber: number;
  prTitle: string;
  prUrl: string;
  branch: string | null;
  repoFullName: string;
}

export type GitHubPrCallback = (event: GitHubPrEvent) => void;

type PrState = { state: 'open' | 'merged' | 'closed' };

type GhPrJson = {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  url: string;
  headRefName: string;
};

export class GitHubPrWatcher implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSeenPrs: Map<number, PrState> = new Map();
  private seeded = false;
  private callback: GitHubPrCallback | undefined;
  private started = false;
  private workspacePath: string | null = null;
  private ghAvailable: boolean | null = null;

  private static readonly POLL_INTERVAL_MS = 60_000;

  onPrEvent(callback: GitHubPrCallback): void {
    this.callback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      console.log(`[BuildersHQ][PrWatcher] start: no workspace folders, skipping`);
      return;
    }
    this.workspacePath = folders[0].uri.fsPath;

    console.log(`[BuildersHQ][PrWatcher] start: cwd=${this.workspacePath}`);

    // Seed current PRs (no false events on startup)
    this.seedCurrentPrs();

    this.pollTimer = setInterval(() => {
      if (this.seeded) { this.checkForNewPrs(); }
    }, GitHubPrWatcher.POLL_INTERVAL_MS);
  }

  stop(): void {
    this.started = false;
    this.seeded = false;
    this.lastSeenPrs.clear();
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  isWatching(): boolean {
    return this.started;
  }

  dispose(): void {
    this.stop();
  }

  /**
   * Runs `gh pr list` to get recent PRs in all states.
   * Uses the gh CLI which inherits the user's local GitHub auth.
   */
  private fetchRecentPrs(): Promise<GhPrJson[] | null> {
    if (!this.workspacePath) { return Promise.resolve(null); }
    if (this.ghAvailable === false) { return Promise.resolve(null); }

    const cwd = this.workspacePath;

    return new Promise((resolve) => {
      execFile('gh', [
        'pr', 'list',
        '--state', 'all',
        '--limit', '15',
        '--json', 'number,title,state,url,headRefName',
      ], { cwd, timeout: 15_000 }, (err, stdout) => {
        if (err) {
          const msg = err.message || String(err);
          if (msg.includes('ENOENT') || msg.includes('not found')) {
            console.log(`[BuildersHQ][PrWatcher] gh CLI not found — PR watching disabled`);
            this.ghAvailable = false;
          } else if (msg.includes('not logged')) {
            console.log(`[BuildersHQ][PrWatcher] gh not authenticated — run "gh auth login"`);
            this.ghAvailable = false;
          } else {
            console.log(`[BuildersHQ][PrWatcher] gh pr list error: ${msg}`);
          }
          resolve(null);
          return;
        }

        this.ghAvailable = true;
        try {
          const prs = JSON.parse(stdout.trim()) as GhPrJson[];
          resolve(prs);
        } catch (parseErr) {
          console.log(`[BuildersHQ][PrWatcher] gh output parse error: ${parseErr}`);
          resolve(null);
        }
      });
    });
  }

  private getRepoFullName(): string | null {
    if (!this.workspacePath) { return null; }
    // Extract from gh — but we'll derive it from PR urls instead
    return null;
  }

  private normalizeState(ghState: string): 'open' | 'merged' | 'closed' {
    switch (ghState) {
      case 'OPEN': return 'open';
      case 'MERGED': return 'merged';
      case 'CLOSED': return 'closed';
      default: return 'closed';
    }
  }

  private async seedCurrentPrs(): Promise<void> {
    const prs = await this.fetchRecentPrs();
    if (prs) {
      for (const pr of prs) {
        this.lastSeenPrs.set(pr.number, { state: this.normalizeState(pr.state) });
      }
    }
    this.seeded = true;
    console.log(`[BuildersHQ][PrWatcher] seeded: ${this.lastSeenPrs.size} PRs, ghAvailable=${this.ghAvailable}`);
  }

  private async checkForNewPrs(): Promise<void> {
    const prs = await this.fetchRecentPrs();
    if (!prs) {
      return;
    }
    console.log(`[BuildersHQ][PrWatcher] poll: fetched ${prs.length} PRs, tracking ${this.lastSeenPrs.size}`);

    for (const pr of prs) {
      const prev = this.lastSeenPrs.get(pr.number);
      const curState = this.normalizeState(pr.state);
      // Extract repo from PR url: https://github.com/owner/repo/pull/N
      const repoMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\//);
      const repoFullName = repoMatch?.[1] ?? '';

      if (!prev) {
        // New PR we haven't seen before
        if (curState === 'open') {
          console.log(`[BuildersHQ][PrWatcher] New open PR #${pr.number}: "${pr.title}"`);
          this.emitEvent({
            timestamp: Date.now(),
            eventType: 'pr_opened',
            prNumber: pr.number,
            prTitle: pr.title.slice(0, 200),
            prUrl: pr.url,
            branch: pr.headRefName || null,
            repoFullName,
          });
        }
      } else if (prev.state === 'open' && curState === 'merged') {
        console.log(`[BuildersHQ][PrWatcher] PR #${pr.number} MERGED`);
        this.emitEvent({
          timestamp: Date.now(),
          eventType: 'pr_merged',
          prNumber: pr.number,
          prTitle: pr.title.slice(0, 200),
          prUrl: pr.url,
          branch: pr.headRefName || null,
          repoFullName,
        });
      } else if (prev.state === 'open' && curState === 'closed') {
        console.log(`[BuildersHQ][PrWatcher] PR #${pr.number} CLOSED`);
        this.emitEvent({
          timestamp: Date.now(),
          eventType: 'pr_closed',
          prNumber: pr.number,
          prTitle: pr.title.slice(0, 200),
          prUrl: pr.url,
          branch: pr.headRefName || null,
          repoFullName,
        });
      }

      this.lastSeenPrs.set(pr.number, { state: curState });
    }
  }

  private emitEvent(event: GitHubPrEvent): void {
    console.log(`[BuildersHQ] PR event detected: ${event.eventType} #${event.prNumber} "${event.prTitle}"`);
    this.callback?.(event);
  }
}
