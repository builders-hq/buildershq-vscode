import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityBatchCallback, ClaudeActivityEvent } from './claudeWatcher';

/**
 * Aider chat history watcher.
 *
 * Aider stores conversation logs in `.aider.chat.history.md` in the project
 * root (append-only Markdown). We stream new content via byte-offset tracking
 * — the same approach used for JSONL watchers.
 *
 * Markdown structure:
 *   # aider chat started at YYYY-MM-DD HH:MM:SS
 *   #### <user message or /command>
 *   <assistant response>
 *
 * User turns start with `####`. Everything else is assistant output.
 */

interface TrackedFile {
  filePath: string;
  byteOffset: number;
  partialLine: string;
  fsWatcher: fs.FSWatcher | null;
  pollingTimer: ReturnType<typeof setInterval> | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
}

export class AiderWatcher implements vscode.Disposable {
  private onActivityBatchCallback: ActivityBatchCallback | undefined;
  private trackedFile: TrackedFile | null = null;
  private redetectionTimer: ReturnType<typeof setInterval> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingEvents: ClaudeActivityEvent[] = [];
  private started: boolean = false;
  private inAssistantBlock: boolean = false;
  private currentSessionId: string = 'aider';
  private lastActivityType: string = '';

  private static readonly BATCH_MAX_EVENTS = 10;
  private static readonly BATCH_MAX_MS = 1000;
  private static readonly REDETECTION_INTERVAL_MS = 30_000;
  private static readonly DEBOUNCE_MS = 200;
  private static readonly POLLING_INTERVAL_MS = 2_000;
  private static readonly RECENT_FILE_READ_BYTES = 4096;

  onActivityBatch(callback: ActivityBatchCallback): void {
    this.onActivityBatchCallback = callback;
  }

  start(): void {
    if (this.started) { return; }
    this.started = true;
    this.findAndWatch();
    this.redetectionTimer = setInterval(() => this.checkForFile(), AiderWatcher.REDETECTION_INTERVAL_MS);
  }

  stop(): void {
    if (!this.started) { return; }
    this.started = false;
    this.flushBatch();
    this.detachFile();
    if (this.redetectionTimer !== undefined) {
      clearInterval(this.redetectionTimer);
      this.redetectionTimer = undefined;
    }
  }

  isWatching(): boolean {
    return this.trackedFile !== null;
  }

  dispose(): void {
    this.stop();
  }

  private resolveHistoryPath(): string | null {
    const config = vscode.workspace.getConfiguration('buildershq');
    const overridePath = config.get<string>('aider.transcriptPath', '');
    if (overridePath) {
      return overridePath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    return path.join(folders[0].uri.fsPath, '.aider.chat.history.md');
  }

  private async findAndWatch(): Promise<void> {
    const filePath = this.resolveHistoryPath();
    if (!filePath) {
      console.log('[BuildersHQ:Aider] No workspace open, skipping Aider tracking');
      return;
    }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      await this.attachToFile(filePath);
    } catch {
      // silent retry — file not present yet
    }
  }

  private async checkForFile(): Promise<void> {
    if (!this.started) { return; }
    if (this.trackedFile) { return; } // Already watching

    const filePath = this.resolveHistoryPath();
    if (!filePath) { return; }

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      console.log(`[BuildersHQ:Aider] Found chat history: ${filePath}`);
      await this.attachToFile(filePath);
    } catch {
      // File doesn't exist yet
    }
  }

  private async attachToFile(filePath: string): Promise<void> {
    if (this.trackedFile) { return; }

    const tracked: TrackedFile = {
      filePath,
      byteOffset: 0,
      partialLine: '',
      fsWatcher: null,
      pollingTimer: undefined,
      debounceTimer: undefined,
    };

    this.trackedFile = tracked;

    try {
      const stat = await fs.promises.stat(filePath);

      // Read last chunk to catch recent activity
      if (stat.size > 0) {
        const readStart = Math.max(0, stat.size - AiderWatcher.RECENT_FILE_READ_BYTES);
        tracked.byteOffset = readStart;
        await this.readNewBytes(tracked);
      }

      this.setupWatcher(tracked);
      console.log(`[BuildersHQ:Aider] Watching: ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ:Aider] Failed to attach: ${msg}`);
      this.trackedFile = null;
    }
  }

  private detachFile(): void {
    if (!this.trackedFile) { return; }
    if (this.trackedFile.fsWatcher) { this.trackedFile.fsWatcher.close(); }
    if (this.trackedFile.pollingTimer !== undefined) { clearInterval(this.trackedFile.pollingTimer); }
    if (this.trackedFile.debounceTimer !== undefined) { clearTimeout(this.trackedFile.debounceTimer); }
    this.trackedFile = null;
  }

  private setupWatcher(tracked: TrackedFile): void {
    try {
      tracked.fsWatcher = fs.watch(tracked.filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.debouncedRead(tracked);
        } else if (eventType === 'rename') {
          this.detachFile();
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

  private startPolling(tracked: TrackedFile): void {
    if (tracked.pollingTimer !== undefined) { return; }
    tracked.pollingTimer = setInterval(() => this.pollFileChange(tracked), AiderWatcher.POLLING_INTERVAL_MS);
  }

  private async pollFileChange(tracked: TrackedFile): Promise<void> {
    try {
      const stat = await fs.promises.stat(tracked.filePath);
      if (stat.size !== tracked.byteOffset) {
        await this.readNewBytes(tracked);
      }
    } catch {
      this.detachFile();
    }
  }

  private debouncedRead(tracked: TrackedFile): void {
    if (tracked.debounceTimer !== undefined) {
      clearTimeout(tracked.debounceTimer);
    }
    tracked.debounceTimer = setTimeout(() => {
      tracked.debounceTimer = undefined;
      this.readNewBytes(tracked);
    }, AiderWatcher.DEBOUNCE_MS);
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
        this.processLine(line);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[BuildersHQ:Aider] Read error: ${msg}`);
    } finally {
      if (fd) {
        await fd.close().catch(() => {});
      }
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) { return; }

    // New chat session marker: # aider chat started at YYYY-MM-DD HH:MM:SS
    if (trimmed.startsWith('# aider chat started at ')) {
      const dateStr = trimmed.replace('# aider chat started at ', '').trim();
      this.currentSessionId = `aider:${dateStr}`;
      this.inAssistantBlock = false;
      return;
    }

    // User turn marker: #### <message or /command>
    if (trimmed.startsWith('#### ')) {
      const userInput = trimmed.slice(5).trim();
      this.inAssistantBlock = false;

      // Check for aider commands
      if (userInput.startsWith('/')) {
        const command = userInput.split(' ')[0];
        this.enqueueEvent({
          timestamp: Date.now(),
          claudeSessionId: this.currentSessionId,
          activityType: 'running_command',
          tool: null,
          filePath: null,
          command: userInput.length > 200 ? userInput.slice(0, 200) : userInput,
          summary: `Aider command: ${command}`,
        });
        return;
      }

      // Regular user prompt
      const preview = userInput.length > 150 ? userInput.slice(0, 150) + '...' : userInput;
      const fullPrompt = userInput.length > 4096 ? userInput.slice(0, 4096) : userInput;
      this.enqueueEvent({
        timestamp: Date.now(),
        claudeSessionId: this.currentSessionId,
        activityType: 'prompting',
        tool: null,
        filePath: null,
        command: null,
        summary: 'Prompting Aider',
        promptPreview: preview,
        prompt: fullPrompt,
      });
      return;
    }

    // Assistant content — detect activity type from content patterns
    // Avoid duplicate events for consecutive assistant lines
    if (!this.inAssistantBlock) {
      this.inAssistantBlock = true;

      // Detect SEARCH/REPLACE blocks (editing activity)
      if (trimmed.startsWith('<<<<<<< SEARCH') || trimmed.startsWith('```')) {
        if (this.lastActivityType !== 'editing') {
          this.lastActivityType = 'editing';
          this.enqueueEvent({
            timestamp: Date.now(),
            claudeSessionId: this.currentSessionId,
            activityType: 'editing',
            tool: null,
            filePath: null,
            command: null,
            summary: 'Editing code',
          });
        }
      } else {
        // General thinking/response
        if (this.lastActivityType !== 'thinking') {
          this.lastActivityType = 'thinking';
          this.enqueueEvent({
            timestamp: Date.now(),
            claudeSessionId: this.currentSessionId,
            activityType: 'thinking',
            tool: null,
            filePath: null,
            command: null,
            summary: 'Thinking',
          });
        }
      }
    }

    // Detect file path references in assistant content
    // Pattern: filename.ext (at start of a SEARCH/REPLACE block)
    if (trimmed.match(/^[a-zA-Z0-9_\-./]+\.[a-zA-Z]+$/) && !trimmed.includes(' ')) {
      // This looks like a file path
      this.enqueueEvent({
        timestamp: Date.now(),
        claudeSessionId: this.currentSessionId,
        activityType: 'editing',
        tool: null,
        filePath: trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed,
        command: null,
        summary: 'Editing code',
      });
      this.lastActivityType = 'editing';
    }
  }

  // --- Batching ---

  private enqueueEvent(event: ClaudeActivityEvent): void {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length >= AiderWatcher.BATCH_MAX_EVENTS) {
      this.flushBatch();
    } else if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => this.flushBatch(), AiderWatcher.BATCH_MAX_MS);
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
