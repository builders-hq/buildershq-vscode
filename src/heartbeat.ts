import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { PresenceStatus, ActivityReason } from './presence';
import { getWorkspaceId, getWorkspaceName } from './workspace';

const ENDPOINT_URL = 'https://vs-code.free.beeceptor.com/presence';
const CLIENT_TYPE = 'vscode';
const CLIENT_VERSION = '0.1.0';

const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function getActiveIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('vibemap');
  return config.get<number>('heartbeatActiveSeconds', 30) * 1000;
}

function getIdleIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('vibemap');
  return config.get<number>('heartbeatIdleSeconds', 120) * 1000;
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
      console.log('[Vibemap] No workspace open, skipping heartbeat');
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

    console.log(`[Vibemap] ${new Date().toLocaleTimeString()} Sending heartbeat: status=${payload.status} reason=${payload.reason} seq=${payload.seq}`);
    this.postPayload(payload);
  }

  private postPayload(payload: HeartbeatPayload): void {
    this.heartbeatInFlight = true;

    const data = JSON.stringify(payload);
    const url = new URL(ENDPOINT_URL);

    const options: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5_000,
    };

    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(options, (res) => {
      res.resume();
      this.heartbeatInFlight = false;

      const success = res.statusCode !== undefined && res.statusCode < 500;
      console.log(`[Vibemap] ${new Date().toLocaleTimeString()} Response: ${res.statusCode}`);

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
    });

    req.on('error', (err) => {
      console.log(`[Vibemap] ${new Date().toLocaleTimeString()} Request error: ${err.message}`);
      this.heartbeatInFlight = false;

      const wasConnected = this.connected;
      this.connected = false;
      this.scheduleRetry();

      if (wasConnected !== this.connected && this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(this.connected);
      }
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.write(data);
    req.end();
  }

  private scheduleRetry(): void {
    this.cancelRetry();

    const delayMs = BACKOFF_DELAYS_MS[Math.min(this.currentBackoffIndex, BACKOFF_DELAYS_MS.length - 1)];
    this.currentBackoffIndex += 1;

    console.log(`[Vibemap] Scheduling retry in ${delayMs}ms (attempt ${this.currentBackoffIndex})`);

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
