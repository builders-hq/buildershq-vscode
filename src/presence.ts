import * as vscode from 'vscode';

export type PresenceStatus = 'active' | 'idle' | 'away';
export type ActivityReason = 'edit' | 'save' | 'editor' | 'focus' | 'none';

const ACTIVE_THRESHOLD_MS = 60_000;   // 60 seconds
const IDLE_THRESHOLD_MS   = 300_000;  // 5 minutes
const EVAL_INTERVAL_MS    = 15_000;   // 15 seconds

export interface PresenceState {
  status: PresenceStatus;
  reason: ActivityReason;
  lastActivityAt: number;
}

export type StateChangeCallback = (
  newStatus: PresenceStatus,
  oldStatus: PresenceStatus,
  reason: ActivityReason
) => void;

export class PresenceTracker implements vscode.Disposable {
  private lastActivityAt: number = Date.now();
  private lastReason: ActivityReason = 'none';
  private currentStatus: PresenceStatus = 'active';
  private windowFocused: boolean = true;
  private evalTimer: ReturnType<typeof setInterval> | undefined;
  private disposables: vscode.Disposable[] = [];
  private onStateChangeCallback: StateChangeCallback | undefined;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(() => this.recordActivity('edit')),
      vscode.workspace.onDidSaveTextDocument(() => this.recordActivity('save')),
      vscode.window.onDidChangeActiveTextEditor(() => this.recordActivity('editor')),
      vscode.window.onDidChangeWindowState((state) => this.onWindowStateChanged(state))
    );
  }

  onStateChange(callback: StateChangeCallback): void {
    this.onStateChangeCallback = callback;
  }

  start(): void {
    this.lastActivityAt = Date.now();
    this.currentStatus = 'active';
    this.evalTimer = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS);
    this.evaluate();
  }

  stop(): void {
    if (this.evalTimer !== undefined) {
      clearInterval(this.evalTimer);
      this.evalTimer = undefined;
    }
  }

  getState(): PresenceState {
    return {
      status: this.currentStatus,
      reason: this.lastReason,
      lastActivityAt: this.lastActivityAt,
    };
  }

  getStatus(): PresenceStatus {
    return this.currentStatus;
  }

  private recordActivity(reason: ActivityReason): void {
    this.lastActivityAt = Date.now();
    this.lastReason = reason;
    this.evaluate();
  }

  private onWindowStateChanged(state: vscode.WindowState): void {
    this.windowFocused = state.focused;
    if (state.focused) {
      this.recordActivity('focus');
    } else {
      this.evaluate();
    }
  }

  private evaluate(): void {
    const elapsed = Date.now() - this.lastActivityAt;
    const oldStatus = this.currentStatus;

    let newStatus: PresenceStatus;

    if (!this.windowFocused) {
      newStatus = 'away';
    } else if (elapsed <= ACTIVE_THRESHOLD_MS) {
      newStatus = 'active';
    } else if (elapsed <= IDLE_THRESHOLD_MS) {
      newStatus = 'idle';
    } else {
      newStatus = 'away';
    }

    this.currentStatus = newStatus;

    if (newStatus !== oldStatus && this.onStateChangeCallback) {
      this.onStateChangeCallback(newStatus, oldStatus, this.lastReason);
    }
  }

  dispose(): void {
    this.stop();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
