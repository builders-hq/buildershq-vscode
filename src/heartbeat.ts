import * as vscode from 'vscode';
import * as os from 'os';
import { PresenceStatus, ActivityReason } from './presence';
import { getWorkspaceId, getWorkspaceName, getRepoUrl, getRepoName } from './workspace';
import { ClaudeActivityEvent } from './claudeWatcher';

const ENDPOINT_URL = 'http://127.0.0.1:3000/api/presence';
const CLIENT_TYPE = 'vscode';
const CLIENT_VERSION = '0.2.0';

const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function getActiveIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('heartbeatActiveSeconds', 30) * 1000;
}

function getIdleIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('weekendmode');
  return config.get<number>('heartbeatIdleSeconds', 60) * 1000;
}

interface ActivityBlock {
  claudeSessionId: string;
  seq: number;
  type: string;
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
  repoUrl?: string;
  repoName?: string;
  computerName: string;
  sessionId: string;
  seq: number;
  focused: boolean;
  client: {
    type: string;
    version: string;
  };
  activities?: ActivityBlock[];
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

  // Repo identity
  private repoUrl: string | null = null;
  private repoName: string | null = null;

  // Claude activity
  private pendingActivities: Map<string, ActivityBlock> = new Map();
  private lastSentActivities: ActivityBlock[] = [];
  private lastActivityAt: number = 0;
  private activitySeq: number = 0;

  private static readonly ACTIVITY_TTL_MS = 600_000; // 10 minutes

  // Network reliability
  private heartbeatInFlight: boolean = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentBackoffIndex: number = 0;

  constructor(sessionId: string, getFocused: () => boolean) {
    this.sessionId = sessionId;
    this.getFocused = getFocused;
  }

  async resolveRepoInfo(): Promise<void> {
    this.repoUrl = await getRepoUrl();
    this.repoName = getRepoName();
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

    this.awaySent = false;
    this.sendHeartbeat();
    this.startPeriodicTimer();
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
    this.startPeriodicTimer();
  }

  stop(): void {
    this.stopPeriodicTimer();
    this.cancelRetry();
  }

  isConnected(): boolean {
    return this.connected;
  }

  setActivity(event: ClaudeActivityEvent, source: string = 'claude_code'): void {
    this.activitySeq += 1;
    this.lastActivityAt = Date.now();
    this.pendingActivities.set(event.claudeSessionId, {
      claudeSessionId: event.claudeSessionId,
      seq: this.activitySeq,
      type: event.activityType,
      tool: event.tool,
      filePath: event.filePath,
      command: event.command,
      summary: event.summary,
      source,
    });
  }

  flushActivity(): void {
    if (this.pendingActivities.size > 0) {
      this.sendHeartbeat();
    }
  }

  async sendDeactivate(): Promise<void> {
    const workspaceId = getWorkspaceId();
    const workspaceName = getWorkspaceName();
    if (!workspaceId || !workspaceName) return;

    const payload: HeartbeatPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      status: 'offline' as PresenceStatus,
      reason: 'none',
      workspaceId,
      workspaceName,
      ...(this.repoUrl && { repoUrl: this.repoUrl }),
      ...(this.repoName && { repoName: this.repoName }),
      computerName: os.hostname(),
      sessionId: this.sessionId,
      seq: Number.MAX_SAFE_INTEGER,
      focused: false,
      client: { type: CLIENT_TYPE, version: CLIENT_VERSION },
    };

    console.log(`[WeekendMode] ${new Date().toLocaleTimeString()} Sending deactivation event`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      await fetch(ENDPOINT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {
      // Best effort — don't block VS Code shutdown
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
      ...(this.repoUrl && { repoUrl: this.repoUrl }),
      ...(this.repoName && { repoName: this.repoName }),
      computerName: os.hostname(),
      sessionId: this.sessionId,
      seq: this.seq,
      focused: this.getFocused(),
      client: {
        type: CLIENT_TYPE,
        version: CLIENT_VERSION,
      },
    };

    if (this.pendingActivities.size > 0) {
      // Merge new activities with existing, keyed by claudeSessionId
      const merged = new Map<string, ActivityBlock>();
      for (const a of this.lastSentActivities) {
        merged.set(a.claudeSessionId, a);
      }
      for (const [, block] of this.pendingActivities) {
        merged.set(block.claudeSessionId, block);
      }
      this.lastSentActivities = Array.from(merged.values());
      this.lastActivityAt = Date.now();
      this.pendingActivities.clear();
      payload.activities = this.lastSentActivities;
    } else if (
      this.lastSentActivities.length > 0 &&
      Date.now() - this.lastActivityAt < HeartbeatService.ACTIVITY_TTL_MS
    ) {
      // No new activity but last known is still fresh — re-send
      payload.activities = this.lastSentActivities;
    } else if (this.lastSentActivities.length > 0) {
      // Expired — clear
      this.lastSentActivities = [];
    }

    const activityInfo = payload.activities ? ` activities=${payload.activities.length}` : '';
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
