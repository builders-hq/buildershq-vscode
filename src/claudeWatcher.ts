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
  | 'idle'
  | 'prompting'
  | 'rate_limited';

export interface ClaudeActivityEvent {
  timestamp: number;
  claudeSessionId: string;
  activityType: ClaudeActivityType;
  tool: string | null;
  filePath: string | null;
  command: string | null;
  summary: string;
  promptPreview?: string;
  gitBranch?: string;
  slug?: string;
  isSidechain?: boolean;
  gitCommitHash?: string;
  aiModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type ActivityBatchCallback = (events: ClaudeActivityEvent[]) => void;

interface TrackedFile {
  filePath: string;
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

interface RecordMeta {
  timestamp: number;
  claudeSessionId: string;
  gitBranch?: string;
  slug?: string;
  isSidechain?: boolean;
  aiModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function classifyToolUse(
  name: string,
  input: Record<string, unknown>,
  meta: RecordMeta,
): ClaudeActivityEvent {
  const base = { ...meta };

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
  meta: RecordMeta,
): ClaudeActivityEvent | null {
  const blockType = block.type as string | undefined;

  if (blockType === 'thinking' || blockType === 'tool_result') {
    return null;
  }

  if (blockType === 'text') {
    return {
      ...meta,
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
    return classifyToolUse(name, input, meta);
  }

  return null;
}

function workspacePathToSlug(workspacePath: string): string {
  return workspacePath.replace(/:/g, '-').replace(/[\\/]/g, '-');
}

function processUserRecord(
  record: Record<string, unknown>,
  enqueue: (event: ClaudeActivityEvent) => void,
): void {
  const message = record.message as Record<string, unknown> | undefined;
  if (!message || message.role !== 'user') { return; }
  const content = message.content;
  if (!Array.isArray(content)) { return; }

  const timestampStr = record.timestamp as string | undefined;
  const timestamp = timestampStr ? new Date(timestampStr).getTime() : Date.now();

  for (const block of content) {
    if (typeof block !== 'object' || block === null) { continue; }
    const b = block as Record<string, unknown>;
    if (b.type !== 'text') { continue; } // skip tool_result blocks

    const rawText = b.text as string | undefined;
    if (!rawText || rawText.trim().length === 0) { continue; }

    const preview = rawText.length > 150 ? rawText.slice(0, 150) + '...' : rawText;

    console.log(`[BuildersHQ:Claude] prompting event — slug=${record.slug} branch=${record.gitBranch} preview="${preview}"`);

    enqueue({
      timestamp,
      claudeSessionId: (record.sessionId as string) || '',
      activityType: 'prompting',
      tool: null,
      filePath: null,
      command: null,
      summary: 'Prompting Claude',
      promptPreview: preview,
      gitBranch: truncate(record.gitBranch as string, 256) ?? undefined,
      slug: truncate(record.slug as string, 256) ?? undefined,
      isSidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : undefined,
    });
    break; // one event per user turn (first non-empty text block only)
  }
}

export class ClaudeCodeWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private trackedFiles: Map<string, TrackedFile> = new Map();
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private started: boolean = false;

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
    this.findAndWatchAll();
    this.redetectionTimer = setInterval(() => this.reconcileActiveFiles(), ClaudeCodeWatcher.REDETECTION_INTERVAL_MS);
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
    return this.trackedFiles.size > 0;
  }

  dispose(): void {
    this.stop();
  }

  // --- Private: file detection ---

  private resolveTranscriptDir(): string | null {
    const config = vscode.workspace.getConfiguration('buildershq');
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

  private async findActiveJsonlFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const jsonlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'));

      if (jsonlFiles.length === 0) { return []; }

      const now = Date.now();
      const stats = await Promise.all(
        jsonlFiles.map(async (e) => {
          const filePath = path.join(dir, e.name);
          const stat = await fs.promises.stat(filePath);
          return { path: filePath, mtimeMs: stat.mtimeMs };
        })
      );

      return stats
        .filter(s => now - s.mtimeMs < ClaudeCodeWatcher.ACTIVE_FILE_THRESHOLD_MS)
        .map(s => s.path);
    } catch {
      return [];
    }
  }

  private async findAndWatchAll(): Promise<void> {
    const dir = this.resolveTranscriptDir();
    if (!dir) {
      console.log('[BuildersHQ:Claude] No workspace open, cannot detect transcript directory');
      return;
    }

    const activeFiles = await this.findActiveJsonlFiles(dir);
    if (activeFiles.length === 0) {
      console.log(`[BuildersHQ:Claude] No active JSONL files found in ${dir}, will retry in 30s`);
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

    const dir = this.resolveTranscriptDir();
    if (!dir) { return; }

    const activeFiles = await this.findActiveJsonlFiles(dir);
    const activeSet = new Set(activeFiles);

    // Detach stale files
    for (const filePath of this.trackedFiles.keys()) {
      if (!activeSet.has(filePath)) {
        console.log(`[BuildersHQ:Claude] Detaching stale transcript: ${path.basename(filePath)}`);
        this.detachFile(filePath);
      }
    }

    // Attach new files
    for (const filePath of activeFiles) {
      if (!this.trackedFiles.has(filePath)) {
        console.log(`[BuildersHQ:Claude] Attaching new transcript: ${path.basename(filePath)}`);
        await this.attachToFile(filePath);
      }
    }
  }

  private async attachToFile(filePath: string): Promise<void> {
    const tracked: TrackedFile = {
      filePath,
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

      // If file was recently modified, read last 8KB to catch in-progress activity
      if (now - stat.mtimeMs < ClaudeCodeWatcher.ACTIVE_FILE_THRESHOLD_MS && stat.size > 0) {
        const readStart = Math.max(0, stat.size - ClaudeCodeWatcher.RECENT_FILE_READ_BYTES);
        tracked.byteOffset = readStart;
        await this.readNewBytes(tracked);
      } else {
        tracked.byteOffset = stat.size;
      }

      this.setupWatcher(tracked);
      console.log(`[BuildersHQ:Claude] Watching: ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ:Claude] Failed to attach to file: ${msg}`);
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

  // --- Private: file watching ---

  private setupWatcher(tracked: TrackedFile): void {
    try {
      tracked.fsWatcher = fs.watch(tracked.filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.debouncedRead(tracked);
        } else if (eventType === 'rename') {
          console.log(`[BuildersHQ:Claude] Transcript file renamed/deleted: ${path.basename(tracked.filePath)}`);
          this.detachFile(tracked.filePath);
        }
      });

      tracked.fsWatcher.on('error', (err) => {
        console.log(`[BuildersHQ:Claude] fs.watch error on ${path.basename(tracked.filePath)}: ${err.message}, falling back to polling`);
        if (tracked.fsWatcher) {
          tracked.fsWatcher.close();
          tracked.fsWatcher = null;
        }
        this.startPolling(tracked);
      });
    } catch {
      console.log(`[BuildersHQ:Claude] fs.watch failed for ${path.basename(tracked.filePath)}, falling back to polling`);
      this.startPolling(tracked);
    }
  }

  private startPolling(tracked: TrackedFile): void {
    if (tracked.pollingTimer !== undefined) { return; }
    tracked.pollingTimer = setInterval(() => this.pollFileChange(tracked), ClaudeCodeWatcher.POLLING_INTERVAL_MS);
  }

  private async pollFileChange(tracked: TrackedFile): Promise<void> {
    try {
      const stat = await fs.promises.stat(tracked.filePath);
      if (stat.size !== tracked.byteOffset) {
        await this.readNewBytes(tracked);
      }
    } catch {
      // File may have been deleted
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
    }, ClaudeCodeWatcher.DEBOUNCE_MS);
  }

  // --- Private: reading & parsing ---

  private async readNewBytes(tracked: TrackedFile): Promise<void> {
    let fd: fs.promises.FileHandle | undefined;
    try {
      const stat = await fs.promises.stat(tracked.filePath);

      // File was truncated or replaced
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

      // Last element is either '' (if text ended with \n) or a partial line
      tracked.partialLine = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) { continue; }
        this.processLine(trimmed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ:Claude] Read error on ${path.basename(tracked.filePath)}: ${msg}`);
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

    if (record.type === 'user') {
      processUserRecord(record, (event) => this.enqueueEvent(event));
      return;
    }
    if (record.type !== 'assistant') { return; }

    const message = record.message as Record<string, unknown> | undefined;
    if (!message || message.role !== 'assistant') { return; }

    const content = message.content;
    if (!Array.isArray(content)) { return; }

    // Parse timestamp from ISO string
    const timestampStr = record.timestamp as string | undefined;
    const timestamp = timestampStr ? new Date(timestampStr).getTime() : Date.now();

    // Detect Claude rate limit notification (synthetic model, no real tokens)
    if (message.model === '<synthetic>') {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) { continue; }
        const b = block as Record<string, unknown>;
        if (b.type !== 'text') { continue; }
        const text = (b.text as string | undefined)?.trim();
        if (!text || !text.includes("You've hit your limit")) { continue; }
        console.log(`[BuildersHQ:Claude] rate_limited event — slug=${record.slug} message="${text}"`);
        this.enqueueEvent({
          timestamp,
          claudeSessionId: (record.sessionId as string) || '',
          activityType: 'rate_limited',
          tool: null,
          filePath: null,
          command: null,
          summary: text,
          gitBranch: truncate(record.gitBranch as string, 256) ?? undefined,
          slug: truncate(record.slug as string, 256) ?? undefined,
          isSidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : undefined,
        });
        break;
      }
      return; // Don't process synthetic records further
    }

    const aiModel = truncate(message.model as string, 64) ?? undefined;
    const usage = message.usage as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
    const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;

    const meta: RecordMeta = {
      timestamp,
      claudeSessionId: (record.sessionId as string) || '',
      gitBranch: truncate(record.gitBranch as string, 256) ?? undefined,
      slug: truncate(record.slug as string, 256) ?? undefined,
      isSidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : undefined,
      aiModel,
      inputTokens,
      outputTokens,
    };

    for (const block of content) {
      if (typeof block !== 'object' || block === null) { continue; }
      const event = classifyContentBlock(block as Record<string, unknown>, meta);
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
