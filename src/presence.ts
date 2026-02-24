import * as vscode from 'vscode';

export type PresenceStatus = 'active' | 'idle' | 'away';
export type ActivityReason =
  | 'edit' | 'save' | 'editor' | 'focus' | 'activate' | 'none'
  | 'debug_start' | 'debug_stop' | 'task_start' | 'task_end';

const EVAL_INTERVAL_MS = 15_000;
const MIN_STATE_DURATION_MS = 15_000;
const FOCUS_DEBOUNCE_MS = 10_000;

function getActiveThresholdMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('idleAfterSeconds', 60) * 1000;
}

function getIdleThresholdMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('awayAfterSeconds', 300) * 1000;
}

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

export type ForceHeartbeatCallback = (reason: ActivityReason) => void;

export class PresenceTracker implements vscode.Disposable {
  private lastActivityAt: number = Date.now();
  private lastReason: ActivityReason = 'none';
  private currentStatus: PresenceStatus = 'active';
  private windowFocused: boolean = true;
  private stateEnteredAt: number = Date.now();
  private evalTimer: ReturnType<typeof setInterval> | undefined;
  private focusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];
  private onStateChangeCallback: StateChangeCallback | undefined;
  private onForceHeartbeatCallback: ForceHeartbeatCallback | undefined;

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

  onForceHeartbeat(callback: ForceHeartbeatCallback): void {
    this.onForceHeartbeatCallback = callback;
  }

  start(): void {
    this.lastActivityAt = Date.now();
    this.currentStatus = 'active';
    this.stateEnteredAt = Date.now();
    this.evalTimer = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS);
    this.evaluate();
  }

  stop(): void {
    if (this.evalTimer !== undefined) {
      clearInterval(this.evalTimer);
      this.evalTimer = undefined;
    }
    if (this.focusDebounceTimer !== undefined) {
      clearTimeout(this.focusDebounceTimer);
      this.focusDebounceTimer = undefined;
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

  isFocused(): boolean {
    return this.windowFocused;
  }

  /**
   * Called by external event listeners (debug sessions, tasks) to record
   * activity and optionally force an immediate heartbeat.
   */
  recordExternalActivity(reason: ActivityReason, forceHeartbeat: boolean): void {
    this.lastActivityAt = Date.now();
    this.lastReason = reason;
    this.evaluate();
    if (forceHeartbeat && this.onForceHeartbeatCallback) {
      this.onForceHeartbeatCallback(reason);
    }
  }

  private recordActivity(reason: ActivityReason): void {
    this.lastActivityAt = Date.now();
    this.lastReason = reason;
    this.evaluate();
  }

  private onWindowStateChanged(state: vscode.WindowState): void {
    this.windowFocused = state.focused;
    if (state.focused) {
      if (this.focusDebounceTimer !== undefined) {
        clearTimeout(this.focusDebounceTimer);
        this.focusDebounceTimer = undefined;
      }
      this.recordActivity('focus');
    } else {
      if (this.focusDebounceTimer === undefined) {
        this.focusDebounceTimer = setTimeout(() => {
          this.focusDebounceTimer = undefined;
          this.evaluate();
        }, FOCUS_DEBOUNCE_MS);
      }
    }
  }

  private evaluate(): void {
    const now = Date.now();
    const elapsed = now - this.lastActivityAt;
    const oldStatus = this.currentStatus;

    const activeThreshold = getActiveThresholdMs();
    const idleThreshold = getIdleThresholdMs();

    // If focus debounce timer is pending, treat window as still focused
    const effectivelyUnfocused = !this.windowFocused && this.focusDebounceTimer === undefined;

    let newStatus: PresenceStatus;

    if (effectivelyUnfocused) {
      newStatus = 'away';
    } else if (elapsed <= activeThreshold) {
      newStatus = 'active';
    } else if (elapsed <= idleThreshold) {
      newStatus = 'idle';
    } else {
      newStatus = 'away';
    }

    // Minimum state duration: suppress transition if current state held < 15s
    // Exception: always allow transitions TO active (responsiveness)
    if (newStatus !== oldStatus && newStatus !== 'active') {
      const stateAge = now - this.stateEnteredAt;
      if (stateAge < MIN_STATE_DURATION_MS) {
        return;
      }
    }

    if (newStatus !== oldStatus) {
      this.stateEnteredAt = now;
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
