import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { PresenceTracker, PresenceStatus, ActivityReason } from './presence';
import { HeartbeatService } from './heartbeat';
import { StatusBarManager } from './statusBar';

const PAUSE_STATE_KEY = 'vibemap.paused';

let presenceTracker: PresenceTracker | undefined;
let heartbeatService: HeartbeatService | undefined;
let statusBarManager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const sessionId = randomUUID();

  presenceTracker = new PresenceTracker();
  heartbeatService = new HeartbeatService(sessionId, () => presenceTracker!.isFocused());
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
  const pauseCmd = vscode.commands.registerCommand('vibemap.pause', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, true);
    heartbeatService!.stop();
    updateStatusBar(context);
  });

  const resumeCmd = vscode.commands.registerCommand('vibemap.resume', async () => {
    await context.globalState.update(PAUSE_STATE_KEY, false);
    const state = presenceTracker!.getState();
    heartbeatService!.start(state.status, state.reason);
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
    if (e.affectsConfiguration('vibemap')) {
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
        const state = presenceTracker!.getState();
        heartbeatService!.onPresenceStateChange(state.status, state.status, state.reason);
      }
    }
  });

  // Start tracking
  presenceTracker.start();

  if (!isPaused) {
    heartbeatService.start('active', 'activate');
  }

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

function updateStatusBar(context: vscode.ExtensionContext): void {
  if (!presenceTracker || !heartbeatService || !statusBarManager) {
    return;
  }
  const paused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);
  const status = presenceTracker.getStatus();
  const connected = heartbeatService.isConnected();
  statusBarManager.update(status, paused, connected);
}

export function deactivate(): void {
  heartbeatService?.dispose();
  presenceTracker = undefined;
  heartbeatService = undefined;
  statusBarManager = undefined;
}
