import * as vscode from 'vscode';
import { PresenceStatus } from './presence';

type DisplayKey = PresenceStatus | 'paused' | 'disconnected';

const STATUS_LABELS: Record<DisplayKey, string> = {
  active:       '$(pulse) BuildersHQ: Active',
  idle:         '$(clock) BuildersHQ: Idle',
  away:         '$(eye-closed) BuildersHQ: Away',
  paused:       '$(debug-pause) BuildersHQ: Paused',
  disconnected: '$(alert) BuildersHQ: Not Connected',
};

const STATUS_TOOLTIPS: Record<DisplayKey, string> = {
  active:       'BuildersHQ is tracking your presence (Active)',
  idle:         'BuildersHQ detected idle state',
  away:         'BuildersHQ detected away state',
  paused:       'BuildersHQ presence tracking is paused',
  disconnected: 'BuildersHQ cannot reach the presence server',
};

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'buildershq.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'BuildersHQ Status';
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
      this.statusBarItem.command = 'buildershq.resume';
    } else if (!connected) {
      displayKey = 'disconnected';
      this.statusBarItem.command = undefined;
    } else {
      displayKey = status;
      this.statusBarItem.command = 'buildershq.pause';
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
