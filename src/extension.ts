import * as vscode from 'vscode';
import { PresenceTracker, PresenceStatus, ActivityReason } from './presence';
import { HeartbeatService } from './heartbeat';
import { StatusBarManager } from './statusBar';

const PAUSE_STATE_KEY = 'vibemap.paused';

let presenceTracker: PresenceTracker | undefined;
let heartbeatService: HeartbeatService | undefined;
let statusBarManager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  presenceTracker = new PresenceTracker();
  heartbeatService = new HeartbeatService();
  statusBarManager = new StatusBarManager();

  const isPaused = context.globalState.get<boolean>(PAUSE_STATE_KEY, false);

  presenceTracker.onStateChange(
    (newStatus: PresenceStatus, oldStatus: PresenceStatus, reason: ActivityReason) => {
      updateStatusBar(context);
      if (!context.globalState.get<boolean>(PAUSE_STATE_KEY, false)) {
        heartbeatService!.onPresenceStateChange(newStatus, oldStatus, reason);
      }
    }
  );

  heartbeatService.onConnectionChange(() => {
    updateStatusBar(context);
  });

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

  presenceTracker.start();

  if (!isPaused) {
    const state = presenceTracker.getState();
    heartbeatService.start(state.status, state.reason);
  }

  updateStatusBar(context);

  context.subscriptions.push(presenceTracker, statusBarManager, pauseCmd, resumeCmd);
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
