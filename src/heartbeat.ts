import * as vscode from 'vscode';
import { PresenceStatus, ActivityReason } from './presence';
import { getWorkspaceId, getWorkspaceName } from './workspace';
import { ClaudeActivityEvent, ClaudeActivityType } from './claudeWatcher';

const ENDPOINT_URL = 'http://127.0.0.1:3000/api/presence';
const CLIENT_TYPE = 'vscode';
const CLIENT_VERSION = '0.1.0';

const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function getActiveIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('heartbeatActiveSeconds', 30) * 1000;
}

function getIdleIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('heartbeatIdleSeconds', 120) * 1000;
}

interface ActivityBlock {
  seq: number;
  type: ClaudeActivityType;
  tool: string | null;
  filePath: string | null;
  command: string | null;
  summary: string;
  source: string;
}

interface HeartbeatPayload {
  timestamp: number;
  status: PresenceStatus;
  reason: ActivityReason;
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  seq: number;
  focused: boolean;
  client: {
    type: string;
    version: string;
  };
  activity?: ActivityBlock;
}

export class HeartbeatService {
  private periodicTimer: ReturnType<typeof setInterval> | undefined;
  private awaySent: boolean = false;
  private currentStatus: PresenceStatus = 'active';
  private currentReason: ActivityReason = 'none';
  private connected: boolean = false;
  private onConnectionChangeCallback: ((connected: boolean) => void) | undefined;

  // Session tracking
  private sessionId: string;
  private seq: number = 0;
  private getFocused: () => boolean;

  // Claude activity
  private pendingActivity: ActivityBlock | null = null;
  private activitySeq: number = 0;

  // Network reliability
  private heartbeatInFlight: boolean = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentBackoffIndex: number = 0;

  constructor(sessionId: string, getFocused: () => boolean) {
    this.sessionId = sessionId;
    this.getFocused = getFocused;
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.onConnectionChangeCallback = callback;
  }

  onPresenceStateChange(
    newStatus: PresenceStatus,
    _oldStatus: PresenceStatus,
    reason: ActivityReason
  ): void {
    this.currentStatus = newStatus;
    this.currentReason = reason;

    if (newStatus === 'away') {
      if (!this.awaySent) {
        this.sendHeartbeat();
        this.awaySent = true;
      }
      this.stopPeriodicTimer();
    } else {
      this.awaySent = false;
      this.sendHeartbeat();
      this.startPeriodicTimer();
    }
  }

  forceHeartbeat(reason: ActivityReason): void {
    this.currentReason = reason;
    this.sendHeartbeat();
  }

  start(status: PresenceStatus, reason: ActivityReason): void {
    this.currentStatus = status;
    this.currentReason = reason;
    this.awaySent = false;
    this.sendHeartbeat();
    if (status !== 'away') {
      this.startPeriodicTimer();
    }
  }

  stop(): void {
    this.stopPeriodicTimer();
    this.cancelRetry();
  }

  isConnected(): boolean {
    return this.connected;
  }

  setActivity(event: ClaudeActivityEvent): void {
    this.activitySeq += 1;
    this.pendingActivity = {
      seq: this.activitySeq,
      type: event.activityType,
      tool: event.tool,
      filePath: event.filePath,
      command: event.command,
      summary: event.summary,
      source: 'claude_code',
    };
  }

  flushActivity(): void {
    if (this.pendingActivity) {
      this.sendHeartbeat();
    }
  }

  dispose(): void {
    this.stop();
  }

  private startPeriodicTimer(): void {
    this.stopPeriodicTimer();
    const interval = this.currentStatus === 'active'
      ? getActiveIntervalMs()
      : getIdleIntervalMs();
    this.periodicTimer = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  private stopPeriodicTimer(): void {
    if (this.periodicTimer !== undefined) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
  }

  private sendHeartbeat(): void {
    if (this.heartbeatInFlight) {
      return;
    }

    const workspaceId = getWorkspaceId();
    const workspaceName = getWorkspaceName();

    if (!workspaceId || !workspaceName) {
      console.log('[WeekendMode] No workspace open, skipping heartbeat');
      return;
    }

    this.seq += 1;

    const payload: HeartbeatPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      status: this.currentStatus,
      reason: this.currentReason,
      workspaceId,
      workspaceName,
      sessionId: this.sessionId,
      seq: this.seq,
      focused: this.getFocused(),
      client: {
        type: CLIENT_TYPE,
        version: CLIENT_VERSION,
      },
    };

    if (this.pendingActivity) {
      payload.activity = this.pendingActivity;
      this.pendingActivity = null;
    }

    const activityInfo = payload.activity ? ` activity=${payload.activity.type} activitySeq=${payload.activity.seq}` : '';
    console.log(`[WeekendMode] ${new Date().toLocaleTimeString()} Sending heartbeat: status=${payload.status} reason=${payload.reason} seq=${payload.seq}${activityInfo}`);
    this.postPayload(payload);
  }

  private async postPayload(payload: HeartbeatPayload): Promise<void> {
    this.heartbeatInFlight = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const res = await fetch(ENDPOINT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const success = res.status < 500;
      console.log(`[WeekendMode] ${new Date().toLocaleTimeString()} Response: ${res.status}`);

      this.heartbeatInFlight = false;
      const wasConnected = this.connected;
      this.connected = success;

      if (success) {
        this.currentBackoffIndex = 0;
        this.cancelRetry();
      } else {
        this.scheduleRetry();
      }

      if (wasConnected !== this.connected && this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(this.connected);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[WeekendMode] ${new Date().toLocaleTimeString()} Request error: ${msg}`);
      this.heartbeatInFlight = false;

      const wasConnected = this.connected;
      this.connected = false;
      this.scheduleRetry();

      if (wasConnected !== this.connected && this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(this.connected);
      }
    }
  }

  private scheduleRetry(): void {
    this.cancelRetry();

    const delayMs = BACKOFF_DELAYS_MS[Math.min(this.currentBackoffIndex, BACKOFF_DELAYS_MS.length - 1)];
    this.currentBackoffIndex += 1;

    console.log(`[WeekendMode] Scheduling retry in ${delayMs}ms (attempt ${this.currentBackoffIndex})`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.sendHeartbeat();
    }, delayMs);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
