import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ActivityBatchCallback, ClaudeActivityEvent } from './claudeWatcher';

interface TrackedFile {
  filePath: string;
  codexSessionId: string;
  workspaceMatched: boolean | null;
  byteOffset: number;
  partialLine: string;
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

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') {
    return Date.now();
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizePathForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function tryParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function classifyFunctionCall(
  name: string,
  args: Record<string, unknown>,
  timestamp: number,
  codexSessionId: string,
): ClaudeActivityEvent {
  const tool = truncate(name, 64);

  switch (name) {
    case 'shell_command':
    case 'shell':
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'running_command',
        tool,
        filePath: null,
        command: truncate((args.command as string) ?? (args.cmd as string), 200),
        summary: 'Running shell command',
      };
    case 'update_plan':
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'thinking',
        tool,
        filePath: null,
        command: null,
        summary: 'Updating plan',
      };
    case 'view_image':
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'reading_files',
        tool,
        filePath: truncate(args.path as string, 200),
        command: null,
        summary: 'Viewing image',
      };
    case 'read_mcp_resource':
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'reading_files',
        tool,
        filePath: null,
        command: null,
        summary: 'Reading MCP resource',
      };
    case 'list_mcp_resources':
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'searching',
        tool,
        filePath: null,
        command: null,
        summary: 'Browsing MCP resources',
      };
    default:
      // Fallback heuristic for future tools.
      if (name.includes('search') || name.includes('find') || name.includes('list')) {
        return {
          timestamp,
          claudeSessionId: codexSessionId,
          activityType: 'searching',
          tool,
          filePath: null,
          command: null,
          summary: 'Searching',
        };
      }
      if (name.includes('read') || name.includes('view')) {
        return {
          timestamp,
          claudeSessionId: codexSessionId,
          activityType: 'reading_files',
          tool,
          filePath: null,
          command: null,
          summary: 'Reading data',
        };
      }
      if (name.includes('shell') || name.includes('command')) {
        return {
          timestamp,
          claudeSessionId: codexSessionId,
          activityType: 'running_command',
          tool,
          filePath: null,
          command: null,
          summary: 'Running command',
        };
      }
      return {
        timestamp,
        claudeSessionId: codexSessionId,
        activityType: 'thinking',
        tool,
        filePath: null,
        command: null,
        summary: 'Working',
      };
  }
}

export class CodexSessionWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private trackedFiles: Map<string, TrackedFile> = new Map();
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private started: boolean = false;
  private workspacePath: string | null = null;

  private static readonly BATCH_MAX_EVENTS = 10;
  private static readonly BATCH_MAX_MS = 1000;
  private static readonly REDETECTION_INTERVAL_MS = 30_000;
  private static readonly DEBOUNCE_MS = 100;
  private static readonly POLLING_INTERVAL_MS = 2_000;
  private static readonly ACTIVE_FILE_THRESHOLD_MS = 600_000;
  private static readonly RECENT_FILE_READ_BYTES = 8192;

  onActivityBatch(callback: ActivityBatchCallback): void {
    this.onActivityBatchCallback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;
    this.refreshWorkspacePath();
    this.findAndWatchAll();
    this.redetectionTimer = setInterval(() => this.reconcileActiveFiles(), CodexSessionWatcher.REDETECTION_INTERVAL_MS);
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
    return [...this.trackedFiles.values()].some((tracked) => tracked.workspaceMatched === true);
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

  private isWorkspaceMatch(cwd: string): boolean {
    if (!this.workspacePath) {
      return false;
    }
    return normalizePathForCompare(cwd) === this.workspacePath;
  }

  private resolveSessionsDir(): string {
    const config = vscode.workspace.getConfiguration('weekendmode');
    const overridePath = config.get<string>('codex.transcriptPath', '');
    if (overridePath) {
      return overridePath;
    }
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  private async collectJsonlFiles(dir: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectJsonlFiles(fullPath, out);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }));
  }

  private async findActiveJsonlFiles(dir: string): Promise<string[]> {
    const allJsonlFiles: string[] = [];
    await this.collectJsonlFiles(dir, allJsonlFiles);

    if (allJsonlFiles.length === 0) {
      return [];
    }

    const now = Date.now();
    const stats = await Promise.all(
      allJsonlFiles.map(async (filePath) => {
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
      .filter((s) => now - s.mtimeMs < CodexSessionWatcher.ACTIVE_FILE_THRESHOLD_MS)
      .map((s) => s.path);
  }

  private async findAndWatchAll(): Promise<void> {
    if (!this.workspacePath) {
      console.log('[WeekendMode:Codex] No workspace open, skipping Codex session tracking');
      return;
    }

    const dir = this.resolveSessionsDir();
    const activeFiles = await this.findActiveJsonlFiles(dir);

    if (activeFiles.length === 0) {
      console.log(`[WeekendMode:Codex] No active JSONL files found in ${dir}, will retry in 30s`);
      return;
    }

    for (const filePath of activeFiles) {
      if (!this.trackedFiles.has(filePath)) {
        await this.attachToFile(filePath);
      }
    }
  }

  private async reconcileActiveFiles(): Promise<void> {
    if (!this.started) { return; }

    this.refreshWorkspacePath();
    if (!this.workspacePath) {
      this.closeAllWatchers();
      return;
    }

    const dir = this.resolveSessionsDir();
    const activeFiles = await this.findActiveJsonlFiles(dir);
    const activeSet = new Set(activeFiles);

    for (const filePath of this.trackedFiles.keys()) {
      if (!activeSet.has(filePath)) {
        console.log(`[WeekendMode:Codex] Detaching stale session: ${path.basename(filePath)}`);
        this.detachFile(filePath);
      }
    }

    for (const filePath of activeFiles) {
      if (!this.trackedFiles.has(filePath)) {
        console.log(`[WeekendMode:Codex] Attaching new session: ${path.basename(filePath)}`);
        await this.attachToFile(filePath);
      }
    }
  }

  private async attachToFile(filePath: string): Promise<void> {
    const tracked: TrackedFile = {
      filePath,
      codexSessionId: path.basename(filePath, '.jsonl'),
      workspaceMatched: null,
      byteOffset: 0,
      partialLine: '',
      fsWatcher: null,
      pollingTimer: undefined,
      debounceTimer: undefined,
    };

    this.trackedFiles.set(filePath, tracked);

    try {
      const stat = await fs.promises.stat(filePath);
      const now = Date.now();

      if (now - stat.mtimeMs < CodexSessionWatcher.ACTIVE_FILE_THRESHOLD_MS && stat.size > 0) {
        const readStart = Math.max(0, stat.size - CodexSessionWatcher.RECENT_FILE_READ_BYTES);
        tracked.byteOffset = readStart;
        await this.readNewBytes(tracked);
      } else {
        tracked.byteOffset = stat.size;
      }

      this.setupWatcher(tracked);
      console.log(`[WeekendMode:Codex] Watching: ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[WeekendMode:Codex] Failed to attach to file: ${msg}`);
      this.trackedFiles.delete(filePath);
    }
  }

  private detachFile(filePath: string): void {
    const tracked = this.trackedFiles.get(filePath);
    if (!tracked) { return; }

    if (tracked.fsWatcher) {
      tracked.fsWatcher.close();
    }
    if (tracked.pollingTimer !== undefined) {
      clearInterval(tracked.pollingTimer);
    }
    if (tracked.debounceTimer !== undefined) {
      clearTimeout(tracked.debounceTimer);
    }
    this.trackedFiles.delete(filePath);
  }

  private setupWatcher(tracked: TrackedFile): void {
    try {
      tracked.fsWatcher = fs.watch(tracked.filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.debouncedRead(tracked);
        } else if (eventType === 'rename') {
          console.log(`[WeekendMode:Codex] Session file renamed/deleted: ${path.basename(tracked.filePath)}`);
          this.detachFile(tracked.filePath);
        }
      });

      tracked.fsWatcher.on('error', (err) => {
        console.log(`[WeekendMode:Codex] fs.watch error on ${path.basename(tracked.filePath)}: ${err.message}, falling back to polling`);
        if (tracked.fsWatcher) {
          tracked.fsWatcher.close();
          tracked.fsWatcher = null;
        }
        this.startPolling(tracked);
      });
    } catch {
      console.log(`[WeekendMode:Codex] fs.watch failed for ${path.basename(tracked.filePath)}, falling back to polling`);
      this.startPolling(tracked);
    }
  }

  private startPolling(tracked: TrackedFile): void {
    if (tracked.pollingTimer !== undefined) { return; }
    tracked.pollingTimer = setInterval(() => this.pollFileChange(tracked), CodexSessionWatcher.POLLING_INTERVAL_MS);
  }

  private async pollFileChange(tracked: TrackedFile): Promise<void> {
    try {
      const stat = await fs.promises.stat(tracked.filePath);
      if (stat.size !== tracked.byteOffset) {
        await this.readNewBytes(tracked);
      }
    } catch {
      this.detachFile(tracked.filePath);
    }
  }

  private closeAllWatchers(): void {
    for (const filePath of [...this.trackedFiles.keys()]) {
      this.detachFile(filePath);
    }
  }

  private debouncedRead(tracked: TrackedFile): void {
    if (tracked.debounceTimer !== undefined) {
      clearTimeout(tracked.debounceTimer);
    }
    tracked.debounceTimer = setTimeout(() => {
      tracked.debounceTimer = undefined;
      this.readNewBytes(tracked);
    }, CodexSessionWatcher.DEBOUNCE_MS);
  }

  private async readNewBytes(tracked: TrackedFile): Promise<void> {
    let fd: fs.promises.FileHandle | undefined;
    try {
      const stat = await fs.promises.stat(tracked.filePath);
      if (stat.size < tracked.byteOffset) {
        tracked.byteOffset = 0;
        tracked.partialLine = '';
      }

      if (stat.size === tracked.byteOffset) { return; }

      const readLength = stat.size - tracked.byteOffset;
      fd = await fs.promises.open(tracked.filePath, 'r');
      const buffer = Buffer.alloc(readLength);
      await fd.read(buffer, 0, readLength, tracked.byteOffset);
      tracked.byteOffset = stat.size;

      const text = tracked.partialLine + buffer.toString('utf-8');
      const lines = text.split('\n');
      tracked.partialLine = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) { continue; }
        this.processLine(trimmed, tracked);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[WeekendMode:Codex] Read error on ${path.basename(tracked.filePath)}: ${msg}`);
    } finally {
      if (fd) {
        await fd.close().catch(() => {});
      }
    }
  }

  private processLine(line: string, tracked: TrackedFile): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    const recordType = record.type as string | undefined;
    if (!recordType) { return; }

    if (recordType === 'session_meta') {
      const payload = asObject(record.payload);
      if (!payload) { return; }
      const cwd = payload.cwd as string | undefined;
      if (cwd) {
        tracked.workspaceMatched = this.isWorkspaceMatch(cwd);
      }
      const id = payload.id as string | undefined;
      if (id) {
        tracked.codexSessionId = id;
      }
      return;
    }

    if (recordType === 'turn_context') {
      const payload = asObject(record.payload);
      if (!payload) { return; }
      const cwd = payload.cwd as string | undefined;
      if (cwd) {
        tracked.workspaceMatched = this.isWorkspaceMatch(cwd);
      }
      return;
    }

    if (tracked.workspaceMatched !== true) {
      return;
    }

    const timestamp = parseTimestamp(record.timestamp);
    if (recordType === 'response_item') {
      const payload = asObject(record.payload);
      if (!payload || payload.type !== 'function_call') {
        return;
      }

      const name = (payload.name as string) ?? '';
      if (!name) { return; }

      const args = tryParseJson(payload.arguments);
      const event = classifyFunctionCall(name, args, timestamp, tracked.codexSessionId);
      this.enqueueEvent(event);
      return;
    }

    if (recordType === 'event_msg') {
      const payload = asObject(record.payload);
      if (!payload) { return; }

      const payloadType = payload.type as string | undefined;
      if (payloadType !== 'agent_reasoning') {
        return;
      }

      this.enqueueEvent({
        timestamp,
        claudeSessionId: tracked.codexSessionId,
        activityType: 'thinking',
        tool: null,
        filePath: null,
        command: null,
        summary: truncate(payload.text as string, 120) ?? 'Thinking',
      });
    }
  }

  private enqueueEvent(event: ClaudeActivityEvent): void {
    this.pendingEvents.push(event);

    if (this.pendingEvents.length >= CodexSessionWatcher.BATCH_MAX_EVENTS) {
      this.flushBatch();
    } else if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => this.flushBatch(), CodexSessionWatcher.BATCH_MAX_MS);
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
