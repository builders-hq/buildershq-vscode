import * as vscode from 'vscode';
import { getRepoName } from './workspace';

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

type PrState = { state: string; mergedAt: string | null };

type GitHubPrApiResponse = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string } | null;
  merged_at: string | null;
};

export class GitHubPrWatcher implements vscode.Disposable {
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSeenPrs: Map<number, PrState> = new Map();
  private seeded = false;
  private callback: GitHubPrCallback | undefined;
  private started = false;
  private lastETag: string | null = null;

  private static readonly POLL_INTERVAL_MS = 60_000; // 60 seconds

  constructor(
    private readonly getAccessToken: () => string | undefined,
  ) {}

  onPrEvent(callback: GitHubPrCallback): void {
    this.callback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;

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
    this.lastETag = null;
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

  private getRepoFullName(): string | null {
    // getRepoName() returns "owner/repo" from cached git remote
    return getRepoName();
  }

  private async fetchRecentPrs(): Promise<GitHubPrApiResponse[] | null> {
    const repoFullName = this.getRepoFullName();
    if (!repoFullName) { return null; }

    const token = this.getAccessToken();
    if (!token) { return null; }

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'buildershq-vscode',
    };

    // Use conditional request to avoid rate limit consumption
    if (this.lastETag) {
      headers['If-None-Match'] = this.lastETag;
    }

    try {
      const url = `https://api.github.com/repos/${repoFullName}/pulls?state=all&sort=updated&per_page=10`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 304) {
        // Not modified — no new data
        return null;
      }

      if (!res.ok) {
        console.log(`[BuildersHQ] GitHub PR fetch failed: ${res.status}`);
        return null;
      }

      const etag = res.headers.get('etag');
      if (etag) {
        this.lastETag = etag;
      }

      return await res.json() as GitHubPrApiResponse[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ] GitHub PR fetch error: ${msg}`);
      return null;
    }
  }

  private async seedCurrentPrs(): Promise<void> {
    const prs = await this.fetchRecentPrs();
    if (prs) {
      for (const pr of prs) {
        this.lastSeenPrs.set(pr.number, {
          state: pr.state,
          mergedAt: pr.merged_at,
        });
      }
    }
    this.seeded = true;
    console.log(`[BuildersHQ] PR watcher seeded: ${this.lastSeenPrs.size} PRs`);
  }

  private async checkForNewPrs(): Promise<void> {
    const repoFullName = this.getRepoFullName();
    if (!repoFullName) {
      console.log(`[BuildersHQ][PrWatcher] checkForNewPrs: no repoFullName, skipping`);
      return;
    }

    const token = this.getAccessToken();
    console.log(`[BuildersHQ][PrWatcher] checkForNewPrs: repo=${repoFullName} hasToken=${!!token} seeded=${this.seeded} lastSeenCount=${this.lastSeenPrs.size}`);

    const prs = await this.fetchRecentPrs();
    if (!prs) {
      console.log(`[BuildersHQ][PrWatcher] checkForNewPrs: fetchRecentPrs returned null (304 or error)`);
      return;
    }
    console.log(`[BuildersHQ][PrWatcher] checkForNewPrs: fetched ${prs.length} PRs`);

    for (const pr of prs) {
      const prev = this.lastSeenPrs.get(pr.number);

      if (!prev) {
        console.log(`[BuildersHQ][PrWatcher] New PR #${pr.number} state=${pr.state} merged_at=${pr.merged_at}`);
        // New PR we haven't seen before
        if (pr.state === 'open') {
          this.emitEvent({
            timestamp: Date.now(),
            eventType: 'pr_opened',
            prNumber: pr.number,
            prTitle: pr.title.slice(0, 200),
            prUrl: pr.html_url,
            branch: pr.head?.ref ?? null,
            repoFullName,
          });
        }
      } else if (!prev.mergedAt && pr.merged_at) {
        console.log(`[BuildersHQ][PrWatcher] PR #${pr.number} was MERGED (prev.mergedAt=${prev.mergedAt} -> cur.merged_at=${pr.merged_at})`);
        // PR was merged since last check
        this.emitEvent({
          timestamp: Date.now(),
          eventType: 'pr_merged',
          prNumber: pr.number,
          prTitle: pr.title.slice(0, 200),
          prUrl: pr.html_url,
          branch: pr.head?.ref ?? null,
          repoFullName,
        });
      } else if (prev.state === 'open' && pr.state === 'closed' && !pr.merged_at) {
        // PR was closed without being merged
        this.emitEvent({
          timestamp: Date.now(),
          eventType: 'pr_closed',
          prNumber: pr.number,
          prTitle: pr.title.slice(0, 200),
          prUrl: pr.html_url,
          branch: pr.head?.ref ?? null,
          repoFullName,
        });
      }

      this.lastSeenPrs.set(pr.number, {
        state: pr.state,
        mergedAt: pr.merged_at,
      });
    }
  }

  private emitEvent(event: GitHubPrEvent): void {
    console.log(`[BuildersHQ] PR event detected: ${event.eventType} #${event.prNumber} "${event.prTitle}"`);
    this.callback?.(event);
  }
}
