import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface GitCommitEvent {
  timestamp: number;
  shortHash: string;
  subject: string;
  branch: string | null;
}

export type GitCommitCallback = (event: GitCommitEvent) => void;

export class GitCommitWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSeenHash: string | null = null;
  private callback: GitCommitCallback | undefined;
  private started = false;
  private workspacePath: string | null = null;

  private static readonly DEBOUNCE_MS = 500;

  onCommit(callback: GitCommitCallback): void {
    this.callback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }

    this.workspacePath = folders[0].uri.fsPath;
    const gitDir = path.join(this.workspacePath, '.git');

    // Seed lastSeenHash so activation doesn't fire a false event
    this.seedCurrentHash();

    // Watch refs/heads/ for branch ref updates (commits, rebases)
    this.watchDir(path.join(gitDir, 'refs', 'heads'));

    // Watch HEAD for checkout/switch events
    this.watchFile(path.join(gitDir, 'HEAD'));
  }

  stop(): void {
    this.started = false;
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
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

  private watchFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) { return; }
      const watcher = fs.watch(filePath, { persistent: false }, (_eventType) => {
        this.debouncedCheck();
      });
      this.watchers.push(watcher);
    } catch { /* file may not exist */ }
  }

  private debouncedCheck(): void {
    if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.checkForNewCommit();
    }, GitCommitWatcher.DEBOUNCE_MS);
  }

  private seedCurrentHash(): void {
    if (!this.workspacePath) { return; }
    execFile('git', ['rev-parse', 'HEAD'], { cwd: this.workspacePath, timeout: 3000 },
      (err, stdout) => {
        if (!err) { this.lastSeenHash = stdout.trim(); }
      });
  }

  private checkForNewCommit(): void {
    if (!this.workspacePath) { return; }
    execFile('git', ['log', '-1', '--format=%H%n%h%n%s%n%D'],
      { cwd: this.workspacePath, timeout: 3000 },
      (err, stdout) => {
        if (err) { return; }
        const lines = stdout.trim().split('\n');
        const fullHash = lines[0];
        const shortHash = lines[1] ?? '';
        const subject = lines[2] ?? '';
        const refs = lines[3] ?? '';

        if (fullHash === this.lastSeenHash) { return; }
        this.lastSeenHash = fullHash;

        const branchMatch = refs.match(/HEAD -> ([^,]+)/);
        const branch = branchMatch ? branchMatch[1].trim() : null;

        console.log(`[WeekendMode] Git commit detected: ${shortHash} "${subject}" on ${branch ?? 'detached'}`);

        if (this.callback) {
          this.callback({
            timestamp: Date.now(),
            shortHash,
            subject: subject.slice(0, 200),
            branch,
          });
        }
      });
  }
}
