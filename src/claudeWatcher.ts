import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type ClaudeActivityType =
  | 'thinking'
  | 'reading_files'
  | 'editing'
  | 'running_command'
  | 'searching'
  | 'idle';

export interface ClaudeActivityEvent {
  timestamp: number;
  claudeSessionId: string;
  activityType: ClaudeActivityType;
  tool: string | null;
  filePath: string | null;
  command: string | null;
  summary: string;
}

export type ActivityBatchCallback = (events: ClaudeActivityEvent[]) => void;

function truncate(value: string | undefined | null, maxLen: number): string | null {
  if (!value) { return null; }
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function classifyToolUse(
  name: string,
  input: Record<string, unknown>,
  timestamp: number,
  sessionId: string,
): ClaudeActivityEvent {
  const base = { timestamp, claudeSessionId: sessionId };

  switch (name) {
    case 'Read':
      return { ...base, activityType: 'reading_files', tool: 'Read', filePath: truncate(input.file_path as string, 200), command: null, summary: 'Reading files' };
    case 'Glob':
      return { ...base, activityType: 'reading_files', tool: 'Glob', filePath: truncate(input.pattern as string, 200), command: null, summary: 'Browsing files' };
    case 'Edit':
      return { ...base, activityType: 'editing', tool: 'Edit', filePath: truncate(input.file_path as string, 200), command: null, summary: 'Editing code' };
    case 'Write':
      return { ...base, activityType: 'editing', tool: 'Write', filePath: truncate(input.file_path as string, 200), command: null, summary: 'Writing file' };
    case 'Bash':
      return { ...base, activityType: 'running_command', tool: 'Bash', filePath: null, command: truncate(input.command as string, 200), summary: 'Running command' };
    case 'Grep':
      return { ...base, activityType: 'searching', tool: 'Grep', filePath: truncate((input.path ?? input.pattern) as string, 200), command: null, summary: 'Searching codebase' };
    case 'Task':
      return { ...base, activityType: 'thinking', tool: 'Task', filePath: null, command: null, summary: 'Delegating task' };
    case 'WebSearch':
      return { ...base, activityType: 'searching', tool: 'WebSearch', filePath: null, command: null, summary: 'Searching web' };
    case 'WebFetch':
      return { ...base, activityType: 'reading_files', tool: 'WebFetch', filePath: null, command: null, summary: 'Fetching web content' };
    default:
      return { ...base, activityType: 'thinking', tool: name, filePath: null, command: null, summary: 'Working' };
  }
}

function classifyContentBlock(
  block: Record<string, unknown>,
  timestamp: number,
  sessionId: string,
): ClaudeActivityEvent | null {
  const blockType = block.type as string | undefined;

  if (blockType === 'thinking' || blockType === 'tool_result') {
    return null;
  }

  if (blockType === 'text') {
    return {
      timestamp,
      claudeSessionId: sessionId,
      activityType: 'thinking',
      tool: null,
      filePath: null,
      command: null,
      summary: 'Thinking',
    };
  }

  if (blockType === 'tool_use') {
    const name = (block.name as string) || '';
    const input = (block.input as Record<string, unknown>) || {};
    return classifyToolUse(name, input, timestamp, sessionId);
  }

  return null;
}

function workspacePathToSlug(workspacePath: string): string {
  return workspacePath.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

export class ClaudeCodeWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private currentFilePath: string | null = null;
  private byteOffset: number = 0;
  private partialLine: string = '';
  private fsWatcher: fs.FSWatcher | null = null;
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private lastWatchEventAt: number = 0;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private watching: boolean = false;
  private started: boolean = false;

  private static readonly BATCH_MAX_EVENTS = 10;
  private static readonly BATCH_MAX_MS = 1000;
  private static readonly REDETECTION_INTERVAL_MS = 30_000;
  private static readonly DEBOUNCE_MS = 100;
  private static readonly POLLING_INTERVAL_MS = 2_000;
  private static readonly POLLING_WATCHDOG_MS = 10_000;
  private static readonly RECENT_FILE_WINDOW_MS = 60_000;
  private static readonly RECENT_FILE_READ_BYTES = 8192;

  onActivityBatch(callback: ActivityBatchCallback): void {
    this.onActivityBatchCallback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;
    this.findAndWatch();
    this.redetectionTimer = setInterval(() => this.checkForNewerFile(), ClaudeCodeWatcher.REDETECTION_INTERVAL_MS);
  }

  stop(): void {
    if (!this.started) { return; }
    this.started = false;
    this.flushBatch();
    this.closeWatcher();
    if (this.redetectionTimer !== undefined) {
      clearInterval(this.redetectionTimer);
      this.redetectionTimer = undefined;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollingTimer !== undefined) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  isWatching(): boolean {
    return this.watching;
  }

  dispose(): void {
    this.stop();
  }

  // --- Private: file detection ---

  private resolveTranscriptDir(): string | null {
    const config = vscode.workspace.getConfiguration('weekendmode');
    const overridePath = config.get<string>('claudeCode.transcriptPath', '');
    if (overridePath) {
      return overridePath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    const workspacePath = folders[0].uri.fsPath;
    const slug = workspacePathToSlug(workspacePath);
    return path.join(os.homedir(), '.claude', 'projects', slug);
  }

  private async findMostRecentJsonl(dir: string): Promise<string | null> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const jsonlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'));

      if (jsonlFiles.length === 0) { return null; }

      const stats = await Promise.all(
        jsonlFiles.map(async (e) => {
          const filePath = path.join(dir, e.name);
          const stat = await fs.promises.stat(filePath);
          return { path: filePath, mtimeMs: stat.mtimeMs };
        })
      );

      stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return stats[0].path;
    } catch {
      return null;
    }
  }

  private async findAndWatch(): Promise<void> {
    const dir = this.resolveTranscriptDir();
    if (!dir) {
      console.log('[WeekendMode:Claude] No workspace open, cannot detect transcript directory');
      this.watching = false;
      return;
    }

    const filePath = await this.findMostRecentJsonl(dir);
    if (!filePath) {
      console.log(`[WeekendMode:Claude] No JSONL files found in ${dir}, will retry in 30s`);
      this.watching = false;
      return;
    }

    await this.attachToFile(filePath);
  }

  private async checkForNewerFile(): Promise<void> {
    if (!this.started) { return; }

    const dir = this.resolveTranscriptDir();
    if (!dir) { return; }

    const newest = await this.findMostRecentJsonl(dir);
    if (!newest) { return; }

    if (newest !== this.currentFilePath) {
      console.log(`[WeekendMode:Claude] Switching to newer transcript: ${path.basename(newest)}`);
      this.closeWatcher();
      await this.attachToFile(newest);
    }
  }

  private async attachToFile(filePath: string): Promise<void> {
    this.currentFilePath = filePath;
    this.partialLine = '';

    try {
      const stat = await fs.promises.stat(filePath);
      const now = Date.now();

      // If file was recently modified, read last 8KB to catch in-progress activity
      if (now - stat.mtimeMs < ClaudeCodeWatcher.RECENT_FILE_WINDOW_MS && stat.size > 0) {
        const readStart = Math.max(0, stat.size - ClaudeCodeWatcher.RECENT_FILE_READ_BYTES);
        this.byteOffset = readStart;
        await this.readNewBytes();
      } else {
        this.byteOffset = stat.size;
      }

      this.setupWatcher(filePath);
      this.watching = true;
      console.log(`[WeekendMode:Claude] Watching: ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[WeekendMode:Claude] Failed to attach to file: ${msg}`);
      this.watching = false;
    }
  }

  // --- Private: file watching ---

  private setupWatcher(filePath: string): void {
    try {
      this.fsWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        this.lastWatchEventAt = Date.now();

        if (eventType === 'change') {
          this.debouncedRead();
        } else if (eventType === 'rename') {
          console.log('[WeekendMode:Claude] Transcript file renamed/deleted, will re-detect');
          this.closeWatcher();
          this.watching = false;
          // Re-detection will happen on next interval
        }
      });

      this.fsWatcher.on('error', (err) => {
        console.log(`[WeekendMode:Claude] fs.watch error: ${err.message}, falling back to polling`);
        this.closeWatcher();
        this.startPolling();
      });
    } catch {
      console.log('[WeekendMode:Claude] fs.watch failed, falling back to polling');
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollingTimer !== undefined) { return; }
    this.pollingTimer = setInterval(() => this.pollFileChange(), ClaudeCodeWatcher.POLLING_INTERVAL_MS);
    this.watching = true;
  }

  private async pollFileChange(): Promise<void> {
    if (!this.currentFilePath) { return; }
    try {
      const stat = await fs.promises.stat(this.currentFilePath);
      if (stat.size !== this.byteOffset) {
        await this.readNewBytes();
      }
    } catch {
      // File may have been deleted
      this.closeWatcher();
      this.watching = false;
    }
  }

  private closeWatcher(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.pollingTimer !== undefined) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    this.currentFilePath = null;
    this.watching = false;
  }

  private debouncedRead(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.readNewBytes();
    }, ClaudeCodeWatcher.DEBOUNCE_MS);
  }

  // --- Private: reading & parsing ---

  private async readNewBytes(): Promise<void> {
    if (!this.currentFilePath) { return; }

    let fd: fs.promises.FileHandle | undefined;
    try {
      const stat = await fs.promises.stat(this.currentFilePath);

      // File was truncated or replaced
      if (stat.size < this.byteOffset) {
        this.byteOffset = 0;
        this.partialLine = '';
      }

      if (stat.size === this.byteOffset) { return; }

      const readLength = stat.size - this.byteOffset;
      fd = await fs.promises.open(this.currentFilePath, 'r');
      const buffer = Buffer.alloc(readLength);
      await fd.read(buffer, 0, readLength, this.byteOffset);
      this.byteOffset = stat.size;

      const text = this.partialLine + buffer.toString('utf-8');
      const lines = text.split('\n');

      // Last element is either '' (if text ended with \n) or a partial line
      this.partialLine = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) { continue; }
        this.processLine(trimmed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[WeekendMode:Claude] Read error: ${msg}`);
    } finally {
      if (fd) {
        await fd.close().catch(() => {});
      }
    }
  }

  private processLine(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      return; // Skip unparseable lines silently
    }

    // Only process assistant messages
    if (record.type !== 'assistant') { return; }

    const message = record.message as Record<string, unknown> | undefined;
    if (!message || message.role !== 'assistant') { return; }

    const content = message.content;
    if (!Array.isArray(content)) { return; }

    // Parse timestamp from ISO string
    const timestampStr = record.timestamp as string | undefined;
    const timestamp = timestampStr ? new Date(timestampStr).getTime() : Date.now();

    const sessionId = (record.sessionId as string) || '';

    for (const block of content) {
      if (typeof block !== 'object' || block === null) { continue; }
      const event = classifyContentBlock(block as Record<string, unknown>, timestamp, sessionId);
      if (event) {
        this.enqueueEvent(event);
      }
    }
  }

  // --- Private: batching ---

  private enqueueEvent(event: ClaudeActivityEvent): void {
    this.pendingEvents.push(event);

    if (this.pendingEvents.length >= ClaudeCodeWatcher.BATCH_MAX_EVENTS) {
      this.flushBatch();
    } else if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => this.flushBatch(), ClaudeCodeWatcher.BATCH_MAX_MS);
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
