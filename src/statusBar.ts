import * as vscode from 'vscode';
import { PresenceStatus } from './presence';

type DisplayKey = PresenceStatus | 'paused' | 'disconnected';

const STATUS_LABELS: Record<DisplayKey, string> = {
  active:       '$(pulse) Vibemap: Active',
  idle:         '$(clock) Vibemap: Idle',
  away:         '$(eye-closed) Vibemap: Away',
  paused:       '$(debug-pause) Vibemap: Paused',
  disconnected: '$(alert) Vibemap: Not Connected',
};

const STATUS_TOOLTIPS: Record<DisplayKey, string> = {
  active:       'Vibemap is tracking your presence (Active)',
  idle:         'Vibemap detected idle state',
  away:         'Vibemap detected away state',
  paused:       'Vibemap presence tracking is paused',
  disconnected: 'Vibemap cannot reach the presence server',
};

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'vibemap.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'Vibemap Status';
    this.statusBarItem.show();
  }

  update(status: PresenceStatus, paused: boolean, connected: boolean): void {
    let displayKey: DisplayKey;

    if (paused) {
      displayKey = 'paused';
      this.statusBarItem.command = 'vibemap.resume';
    } else if (!connected) {
      displayKey = 'disconnected';
      this.statusBarItem.command = undefined;
    } else {
      displayKey = status;
      this.statusBarItem.command = 'vibemap.pause';
    }

    this.statusBarItem.text = STATUS_LABELS[displayKey];
    this.statusBarItem.tooltip = STATUS_TOOLTIPS[displayKey];
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
