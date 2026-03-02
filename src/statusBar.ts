import * as vscode from 'vscode';
import { PresenceStatus } from './presence';

type DisplayKey = PresenceStatus | 'paused' | 'disconnected' | 'not_logged_in';

const STATUS_LABELS: Record<DisplayKey, string> = {
  active:        '$(pulse) BuildersHQ: Active',
  idle:          '$(clock) BuildersHQ: Idle',
  away:          '$(eye-closed) BuildersHQ: Away',
  paused:        '$(debug-pause) BuildersHQ: Paused',
  disconnected:  '$(alert) BuildersHQ: Not Connected',
  not_logged_in: '$(account) BuildersHQ: Login Required',
};

const STATUS_TOOLTIPS: Record<DisplayKey, string> = {
  active:        'BuildersHQ is tracking your presence (Active)',
  idle:          'BuildersHQ detected idle state',
  away:          'BuildersHQ detected away state',
  paused:        'BuildersHQ presence tracking is paused',
  disconnected:  'BuildersHQ cannot reach the presence server',
  not_logged_in: 'Click to log in with GitHub',
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
    authenticated: boolean,
    claudeActive?: boolean,
    codexActive?: boolean,
    opencodeActive?: boolean,
    geminiActive?: boolean,
    aiderActive?: boolean,
  ): void {
    let displayKey: DisplayKey;

    if (!authenticated) {
      displayKey = 'not_logged_in';
      this.statusBarItem.command = 'buildershq.loginWithGitHub';
    } else if (paused) {
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

    const anyAgentActive = claudeActive || codexActive || opencodeActive || geminiActive || aiderActive;
    if (!paused && anyAgentActive) {
      this.statusBarItem.text += ' $(sparkle)';
      const activeLabels: string[] = [];
      if (claudeActive) {
        activeLabels.push('Claude Code active');
      }
      if (codexActive) {
        activeLabels.push('OpenAI Codex active');
      }
      if (opencodeActive) {
        activeLabels.push('Opencode active');
      }
      if (geminiActive) {
        activeLabels.push('Gemini CLI active');
      }
      if (aiderActive) {
        activeLabels.push('Aider active');
      }
      this.statusBarItem.tooltip += ` | ${activeLabels.join(' + ')}`;
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
