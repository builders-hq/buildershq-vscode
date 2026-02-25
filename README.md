# WeekendMode

Presence detection for VS Code. Tracks developer activity and reports status (`active`, `idle`, `away`) to a configurable endpoint.

## Features

- Activity detection for edits, saves, editor switches, window focus, debug sessions, and tasks.
- Presence state machine with automatic `active` -> `idle` -> `away` transitions.
- Heartbeat reporting with retry/backoff and connection state tracking.
- Status bar indicator with pause/resume commands.
- Optional activity feeds:
  - Claude Code session tracking from local `~/.claude/projects/.../*.jsonl`.
  - OpenAI Codex session tracking from local `~/.codex/sessions/.../*.jsonl`.
  - Git commit tracking from `.git/refs` changes.

## Status Bar

| State | Display |
|-------|---------|
| Active | `WeekendMode: Active` |
| Idle | `WeekendMode: Idle` |
| Away | `WeekendMode: Away` |
| Paused | `WeekendMode: Paused` |
| Disconnected | `WeekendMode: Not Connected` |

When Claude/Codex activity is being detected, a sparkle icon is added to the status item tooltip.

## Commands

- `WeekendMode: Pause Presence Tracking`
- `WeekendMode: Resume Presence Tracking`

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `weekendmode.idleAfterSeconds` | `300` | Seconds of inactivity before status becomes idle. |
| `weekendmode.awayAfterSeconds` | `900` | Seconds of inactivity before status becomes away. |
| `weekendmode.heartbeatActiveSeconds` | `30` | Heartbeat interval while active. |
| `weekendmode.heartbeatIdleSeconds` | `60` | Heartbeat interval while idle/away. |
| `weekendmode.gitCommits.enabled` | `true` | Track git commits as developer activity. |
| `weekendmode.claudeCode.enabled` | `true` | Track Claude Code transcript activity. |
| `weekendmode.claudeCode.transcriptPath` | `""` | Override Claude transcript directory. |
| `weekendmode.codex.enabled` | `true` | Track OpenAI Codex session activity. |
| `weekendmode.codex.transcriptPath` | `""` | Override Codex sessions directory. |

## Payload Format

```json
{
  "timestamp": 1700000000,
  "status": "active",
  "reason": "edit",
  "workspaceId": "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  "workspaceName": "my-project",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "seq": 42,
  "focused": true,
  "client": {
    "type": "vscode",
    "version": "0.2.0"
  },
  "activities": [
    {
      "claudeSessionId": "session-id",
      "seq": 7,
      "type": "running_command",
      "tool": "shell_command",
      "command": "npm test",
      "summary": "Running shell command",
      "source": "codex"
    }
  ]
}
```

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host for testing.
