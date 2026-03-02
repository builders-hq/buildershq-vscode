import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ActivityBatchCallback, ClaudeActivityEvent, ClaudeActivityType } from './claudeWatcher';

/**
 * OpenCode (sst/opencode) session watcher.
 *
 * Storage layout:
 *   ~/.local/share/opencode/storage/
 *     session/<project-id>/ses_xxx.json   — session metadata
 *     message/<session-id>/msg_xxx.json   — individual messages
 *
 * We watch message directories for new files to detect activity.
 */

interface TrackedSession {
  sessionId: string;
  projectId: string;
  messageDir: string;
  knownMessageFiles: Set<string>;
  fsWatcher: fs.FSWatcher | null;
  pollingTimer: ReturnType<typeof setInterval> | undefined;
}

function truncate(value: string | undefined | null, maxLen: number): string | null {
  if (!value) { return null; }
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizePathForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function classifyOpencodeTool(toolName: string): { activityType: ClaudeActivityType; summary: string } {
  const lower = toolName.toLowerCase();

  if (lower.includes('read') || lower.includes('view') || lower.includes('glob')) {
    return { activityType: 'reading_files', summary: 'Reading files' };
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch') || lower.includes('apply')) {
    return { activityType: 'editing', summary: 'Editing code' };
  }
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.includes('command')) {
    return { activityType: 'running_command', summary: 'Running command' };
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find') || lower.includes('list')) {
    return { activityType: 'searching', summary: 'Searching' };
  }
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('browse')) {
    return { activityType: 'reading_files', summary: 'Fetching web content' };
  }
  return { activityType: 'thinking', summary: 'Working' };
}

export class OpencodeSessionWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private trackedSessions: Map<string, TrackedSession> = new Map();
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private started: boolean = false;
  private workspacePath: string | null = null;

  private static readonly BATCH_MAX_EVENTS = 10;
  private static readonly BATCH_MAX_MS = 1000;
  private static readonly REDETECTION_INTERVAL_MS = 30_000;
  private static readonly POLLING_INTERVAL_MS = 2_000;
  private static readonly ACTIVE_SESSION_THRESHOLD_MS = 600_000;

  onActivityBatch(callback: ActivityBatchCallback): void {
    this.onActivityBatchCallback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;
    this.refreshWorkspacePath();
    this.findAndWatchSessions();
    this.redetectionTimer = setInterval(() => this.reconcileSessions(), OpencodeSessionWatcher.REDETECTION_INTERVAL_MS);
  }

  stop(): void {
    if (!this.started) { return; }
    this.started = false;
    this.flushBatch();
    this.closeAllWatchers();
    if (this.redetectionTimer !== undefined) {
      clearInterval(this.redetectionTimer);
      this.redetectionTimer = undefined;
    }
  }

  isWatching(): boolean {
    return this.trackedSessions.size > 0;
  }

  dispose(): void {
    this.stop();
  }

  private refreshWorkspacePath(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.workspacePath = null;
      return;
    }
    this.workspacePath = normalizePathForCompare(folders[0].uri.fsPath);
  }

  private resolveStorageDir(): string {
    const config = vscode.workspace.getConfiguration('buildershq');
    const overridePath = config.get<string>('opencode.transcriptPath', '');
    if (overridePath) {
      return overridePath;
    }
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  }

  private async findAndWatchSessions(): Promise<void> {
    if (!this.workspacePath) {
      console.log('[BuildersHQ:Opencode] No workspace open, skipping Opencode tracking');
      return;
    }

    const storageDir = this.resolveStorageDir();
    const sessionDir = path.join(storageDir, 'session');

    try {
      const projectDirs = await fs.promises.readdir(sessionDir, { withFileTypes: true });
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) { continue; }
        await this.scanProjectSessions(storageDir, sessionDir, projectDir.name);
      }
    } catch {
      console.log(`[BuildersHQ:Opencode] No sessions directory found at ${sessionDir}, will retry in 30s`);
    }
  }

  private async scanProjectSessions(storageDir: string, sessionDir: string, projectId: string): Promise<void> {
    const projectPath = path.join(sessionDir, projectId);

    try {
      const sessionFiles = await fs.promises.readdir(projectPath, { withFileTypes: true });
      const now = Date.now();

      for (const entry of sessionFiles) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }

        const filePath = path.join(projectPath, entry.name);
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > OpencodeSessionWatcher.ACTIVE_SESSION_THRESHOLD_MS) { continue; }

        // Read session file to check workspace match
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const session = JSON.parse(content);
          const sessionObj = asObject(session);
          if (!sessionObj) { continue; }

          // Check if session matches current workspace via path field
          const pathInfo = asObject(sessionObj.path);
          const cwd = (pathInfo?.cwd as string) ?? (pathInfo?.root as string);
          if (!cwd || !this.isWorkspaceMatch(cwd)) { continue; }

          const sessionId = (sessionObj.id as string) ?? path.basename(entry.name, '.json');
          if (this.trackedSessions.has(sessionId)) { continue; }

          await this.attachToSession(storageDir, sessionId, projectId);
        } catch {
          // Skip unparseable session files
        }
      }
    } catch {
      // Project dir doesn't exist or isn't readable
    }
  }

  private isWorkspaceMatch(cwd: string): boolean {
    if (!this.workspacePath) { return false; }
    return normalizePathForCompare(cwd) === this.workspacePath;
  }

  private async attachToSession(storageDir: string, sessionId: string, projectId: string): Promise<void> {
    const messageDir = path.join(storageDir, 'message', sessionId);

    // Enumerate existing message files
    const knownFiles = new Set<string>();
    try {
      const entries = await fs.promises.readdir(messageDir);
      for (const name of entries) {
        if (name.endsWith('.json')) {
          knownFiles.add(name);
        }
      }
    } catch {
      // Message dir may not exist yet
    }

    const tracked: TrackedSession = {
      sessionId,
      projectId,
      messageDir,
      knownMessageFiles: knownFiles,
      fsWatcher: null,
      pollingTimer: undefined,
    };

    this.trackedSessions.set(sessionId, tracked);

    // Read the most recent message to get initial state
    if (knownFiles.size > 0) {
      const sortedFiles = [...knownFiles].sort();
      const lastFile = sortedFiles[sortedFiles.length - 1];
      await this.processMessageFile(tracked, path.join(messageDir, lastFile));
    }

    this.setupDirectoryWatcher(tracked);
    console.log(`[BuildersHQ:Opencode] Watching session: ${sessionId}`);
  }

  private setupDirectoryWatcher(tracked: TrackedSession): void {
    try {
      // Ensure directory exists before watching
      fs.mkdirSync(tracked.messageDir, { recursive: true });

      tracked.fsWatcher = fs.watch(tracked.messageDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) { return; }
        if (tracked.knownMessageFiles.has(filename)) { return; }

        tracked.knownMessageFiles.add(filename);
        const filePath = path.join(tracked.messageDir, filename);
        // Small delay to let the file finish writing
        setTimeout(() => this.processMessageFile(tracked, filePath), 100);
      });

      tracked.fsWatcher.on('error', () => {
        if (tracked.fsWatcher) {
          tracked.fsWatcher.close();
          tracked.fsWatcher = null;
        }
        this.startPolling(tracked);
      });
    } catch {
      this.startPolling(tracked);
    }
  }

  private startPolling(tracked: TrackedSession): void {
    if (tracked.pollingTimer !== undefined) { return; }
    tracked.pollingTimer = setInterval(() => this.pollForNewMessages(tracked), OpencodeSessionWatcher.POLLING_INTERVAL_MS);
  }

  private async pollForNewMessages(tracked: TrackedSession): Promise<void> {
    try {
      const entries = await fs.promises.readdir(tracked.messageDir);
      for (const name of entries) {
        if (!name.endsWith('.json')) { continue; }
        if (tracked.knownMessageFiles.has(name)) { continue; }

        tracked.knownMessageFiles.add(name);
        await this.processMessageFile(tracked, path.join(tracked.messageDir, name));
      }
    } catch {
      // Directory may not exist
    }
  }

  private async processMessageFile(tracked: TrackedSession, filePath: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const message = JSON.parse(content);
      const msg = asObject(message);
      if (!msg) { return; }

      const role = msg.role as string | undefined;
      const timeObj = asObject(msg.time);
      const timestamp = timeObj?.completed
        ? new Date(timeObj.completed as string).getTime()
        : timeObj?.created
          ? new Date(timeObj.created as string).getTime()
          : Date.now();

      const aiModel = truncate(msg.modelID as string, 64) ?? undefined;
      const tokensObj = asObject(msg.tokens);
      const inputTokens = typeof tokensObj?.input === 'number' ? tokensObj.input : undefined;
      const outputTokens = typeof tokensObj?.output === 'number' ? tokensObj.output : undefined;

      if (role === 'user') {
        // Extract prompt preview from content
        const contentArr = msg.content;
        let preview: string | undefined;
        if (Array.isArray(contentArr)) {
          for (const block of contentArr) {
            const b = asObject(block);
            if (b?.type === 'text' && typeof b.text === 'string') {
              const text = (b.text as string).trim();
              if (text.length > 0) {
                preview = text.length > 150 ? text.slice(0, 150) + '...' : text;
                break;
              }
            }
          }
        } else if (typeof contentArr === 'string' && contentArr.trim().length > 0) {
          preview = contentArr.length > 150 ? contentArr.slice(0, 150) + '...' : contentArr;
        }

        this.enqueueEvent({
          timestamp,
          claudeSessionId: tracked.sessionId,
          activityType: 'prompting',
          tool: null,
          filePath: null,
          command: null,
          summary: 'Prompting Opencode',
          promptPreview: preview,
          aiModel,
          inputTokens,
          outputTokens,
        });
        return;
      }

      if (role === 'assistant') {
        // Check for tool use in content blocks
        const contentArr = msg.content;
        let emittedToolEvent = false;

        if (Array.isArray(contentArr)) {
          for (const block of contentArr) {
            const b = asObject(block);
            if (!b) { continue; }

            if (b.type === 'tool_use' || b.type === 'tool_call') {
              const toolName = (b.name as string) ?? (b.function as string) ?? '';
              const { activityType, summary } = classifyOpencodeTool(toolName);
              const inputObj = asObject(b.input) ?? asObject(b.arguments);
              this.enqueueEvent({
                timestamp,
                claudeSessionId: tracked.sessionId,
                activityType,
                tool: truncate(toolName, 64),
                filePath: truncate((inputObj?.file_path ?? inputObj?.path) as string, 200),
                command: truncate((inputObj?.command ?? inputObj?.cmd) as string, 200),
                summary,
                aiModel,
                inputTokens,
                outputTokens,
              });
              emittedToolEvent = true;
            }
          }
        }

        if (!emittedToolEvent) {
          // Plain thinking/text response
          this.enqueueEvent({
            timestamp,
            claudeSessionId: tracked.sessionId,
            activityType: 'thinking',
            tool: null,
            filePath: null,
            command: null,
            summary: 'Thinking',
            aiModel,
            inputTokens,
            outputTokens,
          });
        }
      }
    } catch {
      // Skip unparseable message files
    }
  }

  private async reconcileSessions(): Promise<void> {
    if (!this.started) { return; }
    this.refreshWorkspacePath();
    if (!this.workspacePath) {
      this.closeAllWatchers();
      return;
    }
    // Re-scan for new sessions
    await this.findAndWatchSessions();
  }

  private closeAllWatchers(): void {
    for (const [id, tracked] of this.trackedSessions) {
      if (tracked.fsWatcher) { tracked.fsWatcher.close(); }
      if (tracked.pollingTimer !== undefined) { clearInterval(tracked.pollingTimer); }
    }
    this.trackedSessions.clear();
  }

  // --- Batching ---

  private enqueueEvent(event: ClaudeActivityEvent): void {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length >= OpencodeSessionWatcher.BATCH_MAX_EVENTS) {
      this.flushBatch();
    } else if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => this.flushBatch(), OpencodeSessionWatcher.BATCH_MAX_MS);
    }
  }

  private flushBatch(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    if (this.pendingEvents.length === 0) { return; }
    const batch = this.pendingEvents;
    this.pendingEvents = [];
    if (this.onActivityBatchCallback) {
      this.onActivityBatchCallback(batch);
    }
  }
}
