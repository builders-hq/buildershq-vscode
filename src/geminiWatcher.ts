import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ActivityBatchCallback, ClaudeActivityEvent, ClaudeActivityType } from './claudeWatcher';

/**
 * Gemini CLI session watcher.
 *
 * Gemini CLI stores sessions in ~/.gemini/tmp/<project_hash>/chats/.
 * <project_hash> is a SHA-256 of the project root directory path.
 * Filename pattern: session-YYYY-MM-DDTHH-MM-<hash>.json
 *
 * Each JSON file is an array of Gemini API Content objects:
 *   [{ role: "user"|"model", parts: [{ text, functionCall, functionResponse }] }]
 *
 * Since the entire file is rewritten on every turn, we track the last
 * processed message count per file and detect new messages on change.
 */

interface TrackedSession {
  filePath: string;
  sessionId: string;
  lastMessageCount: number;
  fsWatcher: fs.FSWatcher | null;
  pollingTimer: ReturnType<typeof setInterval> | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
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

function classifyGeminiTool(toolName: string): { activityType: ClaudeActivityType; summary: string } {
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower === 'cat' || lower.includes('list_directory')) {
    return { activityType: 'reading_files', summary: 'Reading files' };
  }
  if (lower.includes('edit') || lower.includes('write_file') || lower.includes('patch') || lower.includes('replace')) {
    return { activityType: 'editing', summary: 'Editing code' };
  }
  if (lower.includes('shell') || lower.includes('run') || lower.includes('exec') || lower.includes('command')) {
    return { activityType: 'running_command', summary: 'Running command' };
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find') || lower.includes('glob')) {
    return { activityType: 'searching', summary: 'Searching' };
  }
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('browse') || lower.includes('google')) {
    return { activityType: 'searching', summary: 'Searching web' };
  }
  if (lower.includes('todo') || lower.includes('memory') || lower.includes('save')) {
    return { activityType: 'thinking', summary: 'Planning' };
  }
  return { activityType: 'thinking', summary: 'Working' };
}

export class GeminiSessionWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private trackedSessions: Map<string, TrackedSession> = new Map();
  private dirWatcher: fs.FSWatcher | null = null;
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private started: boolean = false;

  private static readonly BATCH_MAX_EVENTS = 10;
  private static readonly BATCH_MAX_MS = 1000;
  private static readonly REDETECTION_INTERVAL_MS = 30_000;
  private static readonly DEBOUNCE_MS = 300;
  private static readonly POLLING_INTERVAL_MS = 3_000;
  private static readonly ACTIVE_FILE_THRESHOLD_MS = 600_000;

  onActivityBatch(callback: ActivityBatchCallback): void {
    this.onActivityBatchCallback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;
    this.findAndWatchAll();
    this.redetectionTimer = setInterval(() => this.reconcileActiveFiles(), GeminiSessionWatcher.REDETECTION_INTERVAL_MS);
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

  private resolveChatsDir(): string | null {
    const config = vscode.workspace.getConfiguration('buildershq');
    const overridePath = config.get<string>('gemini.transcriptPath', '');
    if (overridePath) {
      return overridePath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    // Gemini CLI uses SHA-256 of the project root to create per-project directories
    const workspacePath = folders[0].uri.fsPath;
    const projectHash = crypto.createHash('sha256').update(workspacePath).digest('hex');
    return path.join(os.homedir(), '.gemini', 'tmp', projectHash, 'chats');
  }

  private async findActiveJsonFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

      if (jsonFiles.length === 0) { return []; }

      const now = Date.now();
      const stats = await Promise.all(
        jsonFiles.map(async (e) => {
          const filePath = path.join(dir, e.name);
          try {
            const stat = await fs.promises.stat(filePath);
            return { path: filePath, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        })
      );

      return stats
        .filter((s): s is { path: string; mtimeMs: number } => s !== null)
        .filter(s => now - s.mtimeMs < GeminiSessionWatcher.ACTIVE_FILE_THRESHOLD_MS)
        .map(s => s.path);
    } catch {
      return [];
    }
  }

  private async findAndWatchAll(): Promise<void> {
    const dir = this.resolveChatsDir();
    if (!dir) {
      console.log('[BuildersHQ:Gemini] No workspace open, skipping Gemini CLI tracking');
      return;
    }

    const activeFiles = await this.findActiveJsonFiles(dir);

    if (activeFiles.length === 0) { return; }

    for (const filePath of activeFiles) {
      if (!this.trackedSessions.has(filePath)) {
        await this.attachToFile(filePath);
      }
    }

    // Watch the directory for new session files
    this.watchDirectory(dir);
  }

  private watchDirectory(dir: string): void {
    if (this.dirWatcher) { return; }
    try {
      this.dirWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) { return; }
        const filePath = path.join(dir, filename);
        if (this.trackedSessions.has(filePath)) { return; }
        this.attachToFile(filePath).catch(() => {});
      });
      this.dirWatcher.on('error', () => {
        if (this.dirWatcher) {
          this.dirWatcher.close();
          this.dirWatcher = null;
        }
      });
    } catch {
      // Directory may not exist yet
    }
  }

  private async attachToFile(filePath: string): Promise<void> {
    const tracked: TrackedSession = {
      filePath,
      sessionId: path.basename(filePath, '.json'),
      lastMessageCount: 0,
      fsWatcher: null,
      pollingTimer: undefined,
      debounceTimer: undefined,
    };

    this.trackedSessions.set(filePath, tracked);

    // Read current state to establish baseline
    try {
      const messages = await this.readSessionFile(filePath);
      if (messages) {
        tracked.lastMessageCount = messages.length;
      }
    } catch {
      // File may not be fully written yet
    }

    this.setupWatcher(tracked);
    console.log(`[BuildersHQ:Gemini] Watching: ${path.basename(filePath)}`);
  }

  private async readSessionFile(filePath: string): Promise<unknown[] | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // Gemini CLI sessions are arrays of Content objects
      if (Array.isArray(parsed)) {
        return parsed;
      }
      // Some formats may wrap in an object with a messages field
      const obj = asObject(parsed);
      if (obj && Array.isArray(obj.messages)) {
        return obj.messages as unknown[];
      }
      return null;
    } catch {
      return null;
    }
  }

  private setupWatcher(tracked: TrackedSession): void {
    try {
      tracked.fsWatcher = fs.watch(tracked.filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.debouncedProcess(tracked);
        } else if (eventType === 'rename') {
          this.detachFile(tracked.filePath);
        }
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
    tracked.pollingTimer = setInterval(() => this.processFileChange(tracked), GeminiSessionWatcher.POLLING_INTERVAL_MS);
  }

  private debouncedProcess(tracked: TrackedSession): void {
    if (tracked.debounceTimer !== undefined) {
      clearTimeout(tracked.debounceTimer);
    }
    tracked.debounceTimer = setTimeout(() => {
      tracked.debounceTimer = undefined;
      this.processFileChange(tracked);
    }, GeminiSessionWatcher.DEBOUNCE_MS);
  }

  private async processFileChange(tracked: TrackedSession): Promise<void> {
    const messages = await this.readSessionFile(tracked.filePath);
    if (!messages) { return; }

    // Process only new messages
    const newMessages = messages.slice(tracked.lastMessageCount);
    tracked.lastMessageCount = messages.length;

    for (const msg of newMessages) {
      const m = asObject(msg);
      if (!m) { continue; }

      const role = m.role as string | undefined;
      const parts = m.parts as unknown[];
      if (!Array.isArray(parts)) { continue; }

      const timestamp = Date.now();

      if (role === 'user') {
        // Check for user text (prompt) vs function response
        for (const part of parts) {
          const p = asObject(part);
          if (!p) { continue; }

          // functionResponse parts are tool results, not user prompts
          if (p.functionResponse) { continue; }

          if (typeof p.text === 'string' && (p.text as string).trim().length > 0) {
            const text = (p.text as string).trim();
            const preview = text.length > 150 ? text.slice(0, 150) + '...' : text;
            const fullPrompt = text.length > 4096 ? text.slice(0, 4096) : text;
            this.enqueueEvent({
              timestamp,
              claudeSessionId: tracked.sessionId,
              activityType: 'prompting',
              tool: null,
              filePath: null,
              command: null,
              summary: 'Prompting Gemini',
              promptPreview: preview,
              prompt: fullPrompt,
            });
            break; // One prompt event per user turn
          }
        }
        continue;
      }

      if (role === 'model') {
        let emittedToolEvent = false;

        for (const part of parts) {
          const p = asObject(part);
          if (!p) { continue; }

          // functionCall parts
          const funcCall = asObject(p.functionCall);
          if (funcCall) {
            const toolName = (funcCall.name as string) ?? '';
            const { activityType, summary } = classifyGeminiTool(toolName);
            const args = asObject(funcCall.args);
            this.enqueueEvent({
              timestamp,
              claudeSessionId: tracked.sessionId,
              activityType,
              tool: truncate(toolName, 64),
              filePath: truncate((args?.path ?? args?.file_path) as string, 200),
              command: truncate((args?.command ?? args?.cmd) as string, 200),
              summary,
            });
            emittedToolEvent = true;
          }
        }

        if (!emittedToolEvent) {
          // Plain text response — thinking
          this.enqueueEvent({
            timestamp,
            claudeSessionId: tracked.sessionId,
            activityType: 'thinking',
            tool: null,
            filePath: null,
            command: null,
            summary: 'Thinking',
          });
        }
      }
    }
  }

  private detachFile(filePath: string): void {
    const tracked = this.trackedSessions.get(filePath);
    if (!tracked) { return; }

    if (tracked.fsWatcher) { tracked.fsWatcher.close(); }
    if (tracked.pollingTimer !== undefined) { clearInterval(tracked.pollingTimer); }
    if (tracked.debounceTimer !== undefined) { clearTimeout(tracked.debounceTimer); }
    this.trackedSessions.delete(filePath);
  }

  private async reconcileActiveFiles(): Promise<void> {
    if (!this.started) { return; }

    const dir = this.resolveChatsDir();
    if (!dir) { return; }

    const activeFiles = await this.findActiveJsonFiles(dir);
    const activeSet = new Set(activeFiles);

    for (const filePath of this.trackedSessions.keys()) {
      if (!activeSet.has(filePath)) {
        console.log(`[BuildersHQ:Gemini] Detaching stale session: ${path.basename(filePath)}`);
        this.detachFile(filePath);
      }
    }

    for (const filePath of activeFiles) {
      if (!this.trackedSessions.has(filePath)) {
        console.log(`[BuildersHQ:Gemini] Attaching new session: ${path.basename(filePath)}`);
        await this.attachToFile(filePath);
      }
    }
  }

  private closeAllWatchers(): void {
    for (const filePath of [...this.trackedSessions.keys()]) {
      this.detachFile(filePath);
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
  }

  // --- Batching ---

  private enqueueEvent(event: ClaudeActivityEvent): void {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length >= GeminiSessionWatcher.BATCH_MAX_EVENTS) {
      this.flushBatch();
    } else if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => this.flushBatch(), GeminiSessionWatcher.BATCH_MAX_MS);
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
