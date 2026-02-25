import * as vscode from 'vscode';
import { PresenceStatus } from './presence';

type DisplayKey = PresenceStatus | 'paused' | 'disconnected';

const STATUS_LABELS: Record<DisplayKey, string> = {
  active:       '$(pulse) WeekendMode: Active',
  idle:         '$(clock) WeekendMode: Idle',
  away:         '$(eye-closed) WeekendMode: Away',
  paused:       '$(debug-pause) WeekendMode: Paused',
  disconnected: '$(alert) WeekendMode: Not Connected',
};

const STATUS_TOOLTIPS: Record<DisplayKey, string> = {
  active:       'WeekendMode is tracking your presence (Active)',
  idle:         'WeekendMode detected idle state',
  away:         'WeekendMode detected away state',
  paused:       'WeekendMode presence tracking is paused',
  disconnected: 'WeekendMode cannot reach the presence server',
};

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'weekendmode.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'WeekendMode Status';
    this.statusBarItem.show();
  }

  update(
    status: PresenceStatus,
    paused: boolean,
    connected: boolean,
    claudeActive?: boolean,
    codexActive?: boolean,
  ): void {
    let displayKey: DisplayKey;

    if (paused) {
      displayKey = 'paused';
      this.statusBarItem.command = 'weekendmode.resume';
    } else if (!connected) {
      displayKey = 'disconnected';
      this.statusBarItem.command = undefined;
    } else {
      displayKey = status;
      this.statusBarItem.command = 'weekendmode.pause';
    }

    this.statusBarItem.text = STATUS_LABELS[displayKey];
    this.statusBarItem.tooltip = STATUS_TOOLTIPS[displayKey];

    if (!paused && (claudeActive || codexActive)) {
      this.statusBarItem.text += ' $(sparkle)';
      const activeLabels: string[] = [];
      if (claudeActive) {
        activeLabels.push('Claude Code active');
      }
      if (codexActive) {
        activeLabels.push('OpenAI Codex active');
      }
      this.statusBarItem.tooltip += ` | ${activeLabels.join(' + ')}`;
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
