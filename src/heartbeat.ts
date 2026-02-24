import * as https from 'https';
import * as http from 'http';
import { PresenceStatus, ActivityReason } from './presence';
import { getWorkspaceId, getWorkspaceName } from './workspace';

const ENDPOINT_URL = 'https://vs-code.free.beeceptor.com/presence';
const CLIENT_TYPE = 'vscode';
const CLIENT_VERSION = '0.1.0';

const ACTIVE_INTERVAL_MS = 30_000;   // 30 seconds
const IDLE_INTERVAL_MS   = 120_000;  // 120 seconds

interface HeartbeatPayload {
  timestamp: number;
  status: PresenceStatus;
  reason: ActivityReason;
  workspaceId: string;
  workspaceName: string;
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
      ? ACTIVE_INTERVAL_MS
      : IDLE_INTERVAL_MS;
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
    const workspaceId = getWorkspaceId();
    const workspaceName = getWorkspaceName();

    if (!workspaceId || !workspaceName) {
      console.log('[Vibemap] No workspace open, skipping heartbeat');
      return;
    }

    const payload: HeartbeatPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      status: this.currentStatus,
      reason: this.currentReason,
      workspaceId,
      workspaceName,
      client: {
        type: CLIENT_TYPE,
        version: CLIENT_VERSION,
      },
    };

    console.log(`[Vibemap] Sending heartbeat: status=${payload.status} reason=${payload.reason}`);
    this.postPayload(payload);
  }

  private postPayload(payload: HeartbeatPayload): void {
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
      timeout: 10_000,
    };

    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(options, (res) => {
      res.resume();
      console.log(`[Vibemap] Response: ${res.statusCode}`);
      const wasConnected = this.connected;
      this.connected = res.statusCode !== undefined && res.statusCode < 500;
      if (wasConnected !== this.connected && this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(this.connected);
      }
    });

    req.on('error', (err) => {
      console.log(`[Vibemap] Request error: ${err.message}`);
      const wasConnected = this.connected;
      this.connected = false;
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
}
