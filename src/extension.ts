import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { PresenceTracker, PresenceStatus, ActivityReason } from './presence';
import { HeartbeatService } from './heartbeat';
import { StatusBarManager } from './statusBar';
import { ClaudeCodeWatcher } from './claudeWatcher';
import { CodexSessionWatcher } from './codexWatcher';
import { GitCommitWatcher } from './gitWatcher';

const PAUSE_STATE_KEY = 'buildershq.paused';

let presenceTracker: PresenceTracker | undefined;
let heartbeatService: HeartbeatService | undefined;
let statusBarManager: StatusBarManager | undefined;
let claudeWatcher: ClaudeCodeWatcher | undefined;
let codexWatcher: CodexSessionWatcher | undefined;
let gitWatcher: GitCommitWatcher | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const sessionId = randomUUID();

  presenceTracker = new PresenceTracker();
  heartbeatService = new HeartbeatService(sessionId, () => presenceTracker!.isFocused());
  heartbeatService.resolveRepoInfo().catch(() => { /* repoUrl stays null */ });
  statusBarManager = new StatusBarManager();

  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  // Wire presence state changes → status bar + heartbeat
  presenceTracker.onStateChange(
    (newStatus: PresenceStatus, oldStatus: PresenceStatus, reason: ActivityReason) => {
      updateStatusBar(context);
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
        heartbeatService!.onPresenceStateChange(newStatus, oldStatus, reason);
      }
    }
  );

  // Wire force heartbeat (for debug/task events that need immediate send)
  presenceTracker.onForceHeartbeat((reason: ActivityReason) => {
    if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
      heartbeatService!.forceHeartbeat(reason);
    }
  });

  // Wire connection changes → status bar
  heartbeatService.onConnectionChange(() => {
    updateStatusBar(context);
  });

  // Pause / Resume commands
  const pauseCmd = vscode.commands.registerCommand('buildershq.pause', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, true);
    heartbeatService!.stop();
    claudeWatcher?.stop();
    codexWatcher?.stop();
    gitWatcher?.stop();
    updateStatusBar(context);
  });

  const resumeCmd = vscode.commands.registerCommand('buildershq.resume', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, false);
    const state = presenceTracker!.getState();
    heartbeatService!.start(state.status, state.reason);
    if (claudeWatcher) {
      claudeWatcher.start();
    }
    if (codexWatcher) {
      codexWatcher.start();
    }
    if (gitWatcher) {
      gitWatcher.start();
    }
    updateStatusBar(context);
  });

  // Debug session activity detection
  const debugStartSub = vscode.debug.onDidStartDebugSession(() => {
    presenceTracker!.recordExternalActivity('debug_start', true);
  });

  const debugStopSub = vscode.debug.onDidTerminateDebugSession(() => {
    presenceTracker!.recordExternalActivity('debug_stop', false);
  });

  // Task activity detection (build/test)
  const taskStartSub = vscode.tasks.onDidStartTaskProcess(() => {
    presenceTracker!.recordExternalActivity('task_start', true);
  });

  const taskEndSub = vscode.tasks.onDidEndTaskProcess(() => {
    presenceTracker!.recordExternalActivity('task_end', false);
  });

  // Restart heartbeat timer when configuration changes
  const configChangeSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('buildershq')) {
      // Existing heartbeat reconfiguration
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
        const state = presenceTracker!.getState();
        heartbeatService!.onPresenceStateChange(state.status, state.status, state.reason);
      }

      // Handle Claude Code enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.claudeCode')) {
        handleClaudeCodeConfigChange(context);
      }

      // Handle OpenAI Codex enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.codex')) {
        handleCodexConfigChange(context);
      }

      // Handle git commits enabled/disabled toggle
      if (e.affectsConfiguration('buildershq.gitCommits')) {
        handleGitCommitsConfigChange(context);
      }
    }
  });

  // Start tracking
  presenceTracker.start();

  if (!isPaused) {
    heartbeatService.start('active', 'activate');
  }

  // Claude Code activity tracking (opt-in)
  initClaudeCodeTracking(context, isPaused);

  // OpenAI Codex activity tracking (opt-in)
  initCodexTracking(context, isPaused);

  // Git commit activity tracking
  initGitCommitTracking(context, isPaused);

  updateStatusBar(context);

  // Register all disposables
  context.subscriptions.push(
    presenceTracker,
    statusBarManager,
    pauseCmd,
    resumeCmd,
    debugStartSub,
    debugStopSub,
    taskStartSub,
    taskEndSub,
    configChangeSub
  );
}

function initClaudeCodeTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('claudeCode.enabled', true)) {
    return;
  }

  claudeWatcher = new ClaudeCodeWatcher();

  claudeWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event);
    }
    // Claude activity counts as user presence — keep status active
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    claudeWatcher.start();
  }

  context.subscriptions.push(claudeWatcher);
}

function handleClaudeCodeConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('claudeCode.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !claudeWatcher) {
    // Turning on
    claudeWatcher = new ClaudeCodeWatcher();

    claudeWatcher.onActivityBatch((events) => {
      if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
      for (const event of events) {
        heartbeatService!.setActivity(event);
      }
      presenceTracker!.recordExternalActivity('task_start', false);
      heartbeatService!.flushActivity();
    });

    if (!isPaused) {
      claudeWatcher.start();
    }

    context.subscriptions.push(claudeWatcher);
  } else if (!enabled && claudeWatcher) {
    // Turning off
    claudeWatcher.dispose();
    claudeWatcher = undefined;
  } else if (enabled && claudeWatcher) {
    // Config changed (e.g. transcriptPath) — restart watcher
    claudeWatcher.stop();
    if (!isPaused) {
      claudeWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initCodexTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('codex.enabled', true)) {
    return;
  }

  codexWatcher = new CodexSessionWatcher();

  codexWatcher.onActivityBatch((events) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    for (const event of events) {
      heartbeatService!.setActivity(event, 'codex');
    }
    // Codex activity counts as user presence - keep status active
    presenceTracker!.recordExternalActivity('task_start', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    codexWatcher.start();
  }

  context.subscriptions.push(codexWatcher);
}

function handleCodexConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('codex.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !codexWatcher) {
    // Turning on
    codexWatcher = new CodexSessionWatcher();

    codexWatcher.onActivityBatch((events) => {
      if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
      for (const event of events) {
        heartbeatService!.setActivity(event, 'codex');
      }
      presenceTracker!.recordExternalActivity('task_start', false);
      heartbeatService!.flushActivity();
    });

    if (!isPaused) {
      codexWatcher.start();
    }

    context.subscriptions.push(codexWatcher);
  } else if (!enabled && codexWatcher) {
    // Turning off
    codexWatcher.dispose();
    codexWatcher = undefined;
  } else if (enabled && codexWatcher) {
    // Config changed (e.g. transcriptPath) - restart watcher
    codexWatcher.stop();
    if (!isPaused) {
      codexWatcher.start();
    }
  }

  updateStatusBar(context);
}

function initGitCommitTracking(
  context: vscode.ExtensionContext,
  isPaused: boolean,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  if (!config.get<boolean>('gitCommits.enabled', true)) {
    return;
  }

  gitWatcher = new GitCommitWatcher();

  gitWatcher.onCommit((event) => {
    if (context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) { return; }
    heartbeatService!.setActivity({
      timestamp: event.timestamp,
      claudeSessionId: 'git',
      activityType: 'git_commit' as 'editing',
      tool: null,
      filePath: event.branch,
      command: null,
      summary: `Committed: ${event.subject}`,
    }, 'git');
    presenceTracker!.recordExternalActivity('save', false);
    heartbeatService!.flushActivity();
  });

  if (!isPaused) {
    gitWatcher.start();
  }

  context.subscriptions.push(gitWatcher);
}

function handleGitCommitsConfigChange(
  context: vscode.ExtensionContext,
): void {
  const config = vscode.workspace.getConfiguration('buildershq');
  const enabled = config.get<boolean>('gitCommits.enabled', true);
  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  if (enabled && !gitWatcher) {
    initGitCommitTracking(context, isPaused);
  } else if (!enabled && gitWatcher) {
    gitWatcher.dispose();
    gitWatcher = undefined;
  }
}

function updateStatusBar(context: vscode.ExtensionContext): void {
  if (!presenceTracker || !heartbeatService || !statusBarManager) {
    return;
  }
  const paused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);
  const status = presenceTracker.getStatus();
  const connected = heartbeatService.isConnected();
  const claudeActive = claudeWatcher?.isWatching() ?? false;
  const codexActive = codexWatcher?.isWatching() ?? false;
  statusBarManager.update(status, paused, connected, claudeActive, codexActive);
}

export async function deactivate(): Promise<void> {
  if (heartbeatService) {
    await heartbeatService.sendDeactivate();
  }
  heartbeatService?.dispose();
  claudeWatcher?.dispose();
  codexWatcher?.dispose();
  gitWatcher?.dispose();
  presenceTracker = undefined;
  heartbeatService = undefined;
  statusBarManager = undefined;
  claudeWatcher = undefined;
  codexWatcher = undefined;
  gitWatcher = undefined;
}
