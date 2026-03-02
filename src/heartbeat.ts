import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { PresenceStatus, ActivityReason } from './presence';
import { getWorkspaceId, getWorkspaceName, getRepoUrl, getRepoName } from './workspace';
import { ClaudeActivityEvent } from './claudeWatcher';
import { ClaimToken } from './githubAuth';

const ENDPOINT_URL = 'https://buildershq.net/api/presence';
const CLIENT_TYPE = 'vscode';
const SCHEMA_VERSION = 1;

function getClientVersion(): string {
  return vscode.extensions.getExtension('appmakers.buildershq')?.packageJSON?.version ?? '0.0.0';
}

function getGitBranch(): string | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt?.isActive) { return null; }
    const api = gitExt.exports.getAPI(1);
    return api.repositories[0]?.state.HEAD?.name ?? null;
  } catch {
    return null;
  }
}

const BACKOFF_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function getActiveIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('buildershq');
  return config.get<number>('heartbeatActiveSeconds', 30) * 1000;
}

function getIdleIntervalMs(): number {
  const config = vscode.workspace.getConfiguration('buildershq');
  return config.get<number>('heartbeatIdleSeconds', 60) * 1000;
}

interface ActivityBlock {
  claudeSessionId: string;
  seq: number;
  timestamp?: number;
  type: string;
  tool: string | null;
  filePath: string | null;
  command: string | null;
  summary: string;
  promptPreview?: string;
  source: string;
  gitBranch?: string;
  slug?: string;
  isSidechain?: boolean;
  gitCommitHash?: string;
  aiModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface HeartbeatUser {
  githubUserId: number;
  githubLogin: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface HeartbeatPayload {
  timestamp: number;
  schemaVersion: number;
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
  platform: {
    os: string;
    arch: string;
    vscodeVersion: string;
  };
  client: {
    type: string;
    version: string;
  };
  activeFileLanguage?: string | null;
  activeFileExt?: string | null;
  gitBranch?: string | null;
  debugType?: string | null;
  taskName?: string | null;
  multiRootWorkspace?: boolean;
  machineToken?: string;
  user?: HeartbeatUser;
  activities?: ActivityBlock[];
}

interface HeartbeatServiceOptions {
  endpointUrl?: string;
  getUser?: () => HeartbeatUser | undefined;
  getAccessToken?: () => string | undefined;
  getMachineToken?: () => string | undefined;
  persistPayload?: (payload: HeartbeatPayload) => Promise<void>;
}

export class HeartbeatService {
  private periodicTimer: ReturnType<typeof setInterval> | undefined;
  private awaySent: boolean = false;
  private currentStatus: PresenceStatus = 'active';
  private currentReason: ActivityReason = 'none';
  private connected: boolean = false;
  private onConnectionChangeCallback: ((connected: boolean) => void) | undefined;
  private onAuthFailureCallback: (() => void) | undefined;
  private onClaimTokenCallback: ((claim: ClaimToken) => void) | undefined;

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

  // External context
  private currentDebugType: string | null = null;
  private currentTaskName: string | null = null;

  private static readonly ACTIVITY_TTL_MS = 600_000; // 10 minutes

  // Network reliability
  private heartbeatInFlight: boolean = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentBackoffIndex: number = 0;
  private endpointUrl: string;
  private readonly getUser: (() => HeartbeatUser | undefined) | undefined;
  private readonly getAccessToken: (() => string | undefined) | undefined;
  private readonly getMachineToken: (() => string | undefined) | undefined;
  private readonly persistPayload: ((payload: HeartbeatPayload) => Promise<void>) | undefined;

  constructor(
    sessionId: string,
    getFocused: () => boolean,
    options: HeartbeatServiceOptions = {},
  ) {
    this.sessionId = sessionId;
    this.getFocused = getFocused;
    this.endpointUrl = options.endpointUrl ?? ENDPOINT_URL;
    this.getUser = options.getUser;
    this.getAccessToken = options.getAccessToken;
    this.getMachineToken = options.getMachineToken;
    this.persistPayload = options.persistPayload;
  }

  async resolveRepoInfo(): Promise<void> {
    this.repoUrl = await getRepoUrl();
    this.repoName = getRepoName();
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.onConnectionChangeCallback = callback;
  }

  onAuthFailure(callback: () => void): void {
    this.onAuthFailureCallback = callback;
  }

  onClaimToken(callback: (claim: ClaimToken) => void): void {
    this.onClaimTokenCallback = callback;
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

  setEndpointUrl(url: string): void {
    this.endpointUrl = url;
  }

  setActivity(event: ClaudeActivityEvent, source: string = 'claude_code'): void {
    this.activitySeq += 1;
    this.lastActivityAt = Date.now();
    this.pendingActivities.set(event.claudeSessionId, {
      claudeSessionId: event.claudeSessionId,
      seq: this.activitySeq,
      timestamp: event.timestamp,
      type: event.activityType,
      tool: event.tool,
      filePath: event.filePath,
      command: event.command,
      summary: event.summary,
      ...(event.promptPreview && { promptPreview: event.promptPreview }),
      source,
      ...(event.gitBranch && { gitBranch: event.gitBranch }),
      ...(event.slug && { slug: event.slug }),
      ...(event.isSidechain !== undefined && { isSidechain: event.isSidechain }),
      ...(event.gitCommitHash && { gitCommitHash: event.gitCommitHash }),
      ...(event.aiModel && { aiModel: event.aiModel }),
      ...(event.inputTokens !== undefined && { inputTokens: event.inputTokens }),
      ...(event.outputTokens !== undefined && { outputTokens: event.outputTokens }),
    });
  }

  flushActivity(): void {
    if (this.pendingActivities.size > 0) {
      this.sendHeartbeat();
    }
  }

  setDebugType(type: string | null): void {
    this.currentDebugType = type;
  }

  setTaskName(name: string | null): void {
    this.currentTaskName = name;
  }

  async sendDeactivate(): Promise<void> {
    const workspaceId = getWorkspaceId();
    const workspaceName = getWorkspaceName();
    if (!workspaceId || !workspaceName) return;

    const payload: HeartbeatPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      schemaVersion: SCHEMA_VERSION,
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
      platform: { os: process.platform, arch: process.arch, vscodeVersion: vscode.version },
      client: { type: CLIENT_TYPE, version: getClientVersion() },
    };
    const user = this.getUser?.();
    if (user) {
      payload.user = user;
    }

    console.log(`[BuildersHQ] ${new Date().toLocaleTimeString()} Sending deactivation event`);
    this.persist(payload);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.getAccessToken?.();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
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
      console.log('[BuildersHQ] No workspace open, skipping heartbeat');
      return;
    }

    this.seq += 1;

    const activeEditor = vscode.window.activeTextEditor;
    const activeFileLanguage = activeEditor?.document.languageId ?? null;
    const activeFileName = activeEditor?.document.fileName ?? '';
    const activeFileExt = activeFileName ? (path.extname(activeFileName) || null) : null;
    const gitBranch = getGitBranch();
    const folders = vscode.workspace.workspaceFolders;
    const multiRootWorkspace = (folders?.length ?? 0) > 1;

    const payload: HeartbeatPayload = {
      timestamp: Math.floor(Date.now() / 1000),
      schemaVersion: SCHEMA_VERSION,
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
      platform: { os: process.platform, arch: process.arch, vscodeVersion: vscode.version },
      client: { type: CLIENT_TYPE, version: getClientVersion() },
      activeFileLanguage,
      activeFileExt,
      gitBranch,
      multiRootWorkspace,
      ...(this.currentDebugType !== null && { debugType: this.currentDebugType }),
      ...(this.currentTaskName !== null && { taskName: this.currentTaskName }),
    };
    const user = this.getUser?.();
    if (user) {
      payload.user = user;
    }
    // Include machineToken for anonymous identification.
    // The server uses this random secret (not spoofable computerName) to
    // securely deliver claim tokens when the user logs in on the website.
    const machineToken = this.getMachineToken?.();
    if (machineToken && !this.getAccessToken?.()) {
      payload.machineToken = machineToken;
    }

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
      Date.now() - this.lastActivityAt >= HeartbeatService.ACTIVITY_TTL_MS
    ) {
      // Expired — clear
      this.lastSentActivities = [];
    }

    const activityInfo = payload.activities ? ` activities=${payload.activities.length}` : '';
    console.log(`[BuildersHQ] ${new Date().toLocaleTimeString()} Sending heartbeat: status=${payload.status} reason=${payload.reason} seq=${payload.seq}${activityInfo}`);
    this.persist(payload);
    this.postPayload(payload);
  }

  private async postPayload(payload: HeartbeatPayload): Promise<void> {
    this.heartbeatInFlight = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.getAccessToken?.();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      console.log(`[BuildersHQ] ${new Date().toLocaleTimeString()} Response: ${res.status}`);
      this.heartbeatInFlight = false;

      // Auth failure handling
      if (res.status === 401) {
        const hadToken = Boolean(this.getAccessToken?.());
        if (hadToken) {
          // Token was sent but rejected — try to refresh/re-exchange
          console.log('[BuildersHQ] Authentication failed (401) — token rejected');
          this.onAuthFailureCallback?.();
        } else {
          // No token was sent (anonymous mode) — the server doesn't support
          // anonymous heartbeats.  Treat as a soft failure: mark disconnected
          // so the status bar shows the issue, but don't trigger auth recovery.
          console.log('[BuildersHQ] Anonymous heartbeat rejected (401) — server requires auth');
        }
        return;
      }

      const success = res.status < 500;
      const wasConnected = this.connected;
      this.connected = success;

      if (success) {
        this.currentBackoffIndex = 0;
        this.cancelRetry();

        // Check for reverse-identification claim token in the response.
        // Only parse the body when anonymous (no access token) to avoid
        // needless JSON parsing on every authenticated heartbeat.
        if (!this.getAccessToken?.() && this.onClaimTokenCallback) {
          await this.tryReadClaimToken(res);
        }
      } else {
        this.scheduleRetry();
      }

      if (wasConnected !== this.connected && this.onConnectionChangeCallback) {
        this.onConnectionChangeCallback(this.connected);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ] ${new Date().toLocaleTimeString()} Request error: ${msg}`);
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

    console.log(`[BuildersHQ] Scheduling retry in ${delayMs}ms (attempt ${this.currentBackoffIndex})`);

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

  /**
   * Try to read a claimToken from the heartbeat response body.
   * The server includes this when a user has logged in on the website and
   * claimed this machineToken.  Safe to call on any response — silently
   * ignores empty bodies, non-JSON, or missing fields.
   */
  private async tryReadClaimToken(res: Response): Promise<void> {
    try {
      const body = await res.json() as Record<string, unknown>;
      if (!body || typeof body !== 'object' || !body.claimToken) {
        return;
      }
      const ct = body.claimToken as Record<string, unknown>;
      if (typeof ct.accessToken !== 'string' || typeof ct.refreshToken !== 'string' ||
          !ct.user || typeof ct.user !== 'object') {
        return;
      }
      const user = ct.user as Record<string, unknown>;
      if (typeof user.githubUserId !== 'number' || typeof user.githubLogin !== 'string') {
        return;
      }
      console.log(`[BuildersHQ] Claim token received for @${user.githubLogin}`);
      this.onClaimTokenCallback!({
        accessToken: ct.accessToken as string,
        refreshToken: ct.refreshToken as string,
        user: {
          githubUserId: user.githubUserId as number,
          githubLogin: user.githubLogin as string,
          name: (user.name as string | null) ?? null,
          email: (user.email as string | null) ?? null,
          avatarUrl: (user.avatarUrl as string | null) ?? null,
        },
      });
    } catch {
      // Response body was not valid JSON or empty — normal for most
      // heartbeat responses.  Silently ignore.
    }
  }

  private persist(payload: HeartbeatPayload): void {
    if (!this.persistPayload) {
      return;
    }
    void this.persistPayload(payload).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[BuildersHQ] Failed to persist heartbeat: ${message}`);
    });
  }
}
