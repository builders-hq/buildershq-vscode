import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface GitBranchEvent {
  timestamp: number;
  eventType: 'branch_created' | 'branch_deleted';
  branchName: string;
}

export type GitBranchCallback = (event: GitBranchEvent) => void;

export class GitBranchWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private knownBranches: Set<string> = new Set();
  private seeded = false;
  private callback: GitBranchCallback | undefined;
  private started = false;
  private workspacePath: string | null = null;

  private static readonly DEBOUNCE_MS = 1000;
  private static readonly POLL_INTERVAL_MS = 30_000;

  onBranchEvent(callback: GitBranchCallback): void {
    this.callback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }

    this.workspacePath = folders[0].uri.fsPath;
    const gitDir = path.join(this.workspacePath, '.git');

    // Seed known branches (no false events on startup)
    this.seedCurrentBranches();

    // Watch refs/heads/ for branch ref changes
    this.watchDir(path.join(gitDir, 'refs', 'heads'));

    // Polling fallback — catches changes missed by fs.watch
    this.pollTimer = setInterval(() => {
      if (this.seeded) { this.checkForBranchChanges(); }
    }, GitBranchWatcher.POLL_INTERVAL_MS);
  }

  stop(): void {
    this.started = false;
    this.seeded = false;
    this.knownBranches.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  private watchDir(dir: string): void {
    try {
      if (!fs.existsSync(dir)) { return; }
      const watcher = fs.watch(dir, { recursive: true, persistent: false }, () => {
        this.debouncedCheck();
      });
      this.watchers.push(watcher);
    } catch { /* directory may not exist */ }
  }

  private debouncedCheck(): void {
    if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.checkForBranchChanges();
    }, GitBranchWatcher.DEBOUNCE_MS);
  }

  private seedCurrentBranches(): void {
    if (!this.workspacePath) {
      this.seeded = true;
      return;
    }
    execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { cwd: this.workspacePath, timeout: 3000 },
      (err, stdout) => {
        if (!err) {
          for (const line of stdout.trim().split('\n')) {
            const branch = line.trim();
            if (branch) { this.knownBranches.add(branch); }
          }
        }
        this.seeded = true;
        console.log(`[BuildersHQ] Branch watcher seeded: ${this.knownBranches.size} branches`);
      });
  }

  private checkForBranchChanges(): void {
    if (!this.workspacePath || !this.seeded) { return; }
    execFile('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { cwd: this.workspacePath, timeout: 3000 },
      (err, stdout) => {
        if (err) { return; }

        const currentBranches = new Set<string>();
        for (const line of stdout.trim().split('\n')) {
          const branch = line.trim();
          if (branch) { currentBranches.add(branch); }
        }

        // Detect new branches
        for (const branch of currentBranches) {
          if (!this.knownBranches.has(branch)) {
            console.log(`[BuildersHQ] Branch created: ${branch}`);
            this.callback?.({
              timestamp: Date.now(),
              eventType: 'branch_created',
              branchName: branch,
            });
          }
        }

        // Detect deleted branches
        for (const branch of this.knownBranches) {
          if (!currentBranches.has(branch)) {
            console.log(`[BuildersHQ] Branch deleted: ${branch}`);
            this.callback?.({
              timestamp: Date.now(),
              eventType: 'branch_deleted',
              branchName: branch,
            });
          }
        }

        this.knownBranches = currentBranches;
      });
  }
}
