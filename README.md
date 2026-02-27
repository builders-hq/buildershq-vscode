# BuildersHQ

Track your developer presence in VS Code. BuildersHQ detects activity — edits, saves, debug sessions, Claude Code usage, git commits — and reports your status (`active`, `idle`, or `away`) to a local BuildersHQ server. All data stays on your machine or your team's own infrastructure.

## Requirements

- A running BuildersHQ server (defaults to `http://127.0.0.1:3000/api/presence`).
- VS Code 1.85 or later.

## Features

- Presence state machine with automatic `active` → `idle` → `away` transitions.
- Heartbeat reporting with configurable endpoint, retry/backoff, and connection state tracking.
- Status bar indicator with pause/resume commands.
- Activity feeds:
  - **Claude Code** session tracking from local `~/.claude/projects/.../*.jsonl` transcripts.
  - **OpenAI Codex** session tracking from local `~/.codex/sessions/.../*.jsonl` transcripts.
  - **Git commit** tracking from `.git/refs` changes.
- GitHub authentication via VS Code's built-in account provider.

## Setup

1. Install the extension.
2. Ensure your BuildersHQ server is running.
3. If your server is not on the default port, set `buildershq.serverUrl` in VS Code Settings.
4. Optionally log in with GitHub via the Command Palette (`BuildersHQ: Login with GitHub`) to enable user-attributed heartbeats.

## Status Bar

| State | Display |
|-------|---------|
| Active | `BuildersHQ: Active` |
| Idle | `BuildersHQ: Idle` |
| Away | `BuildersHQ: Away` |
| Paused | `BuildersHQ: Paused` |
| Disconnected | `BuildersHQ: Not Connected` |

When Claude Code or Codex activity is detected, a sparkle icon appears in the status bar tooltip.

## Commands

| Command | Description |
|---------|-------------|
| `BuildersHQ: Pause Presence Tracking` | Stop sending heartbeats. |
| `BuildersHQ: Resume Presence Tracking` | Resume sending heartbeats. |
| `BuildersHQ: Login with GitHub` | Authenticate to enable user-attributed heartbeats. |
| `BuildersHQ: Logout from GitHub` | Remove stored GitHub credentials. |

`Login with GitHub` first tries VS Code's built-in GitHub auth provider. If unavailable, it falls back to device-flow using credentials from the optional `.env` file.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `buildershq.serverUrl` | `http://127.0.0.1:3000/api/presence` | URL of the BuildersHQ presence API endpoint. |
| `buildershq.idleAfterSeconds` | `300` | Seconds of inactivity before status becomes idle. |
| `buildershq.awayAfterSeconds` | `900` | Seconds of inactivity before status becomes away. |
| `buildershq.heartbeatActiveSeconds` | `30` | Heartbeat interval while active (seconds). |
| `buildershq.heartbeatIdleSeconds` | `60` | Heartbeat interval while idle/away (seconds). |
| `buildershq.gitCommits.enabled` | `true` | Track git commits as developer activity. |
| `buildershq.claudeCode.enabled` | `true` | Track Claude Code transcript activity. |
| `buildershq.claudeCode.transcriptPath` | `""` | Override Claude transcript directory (auto-detected if empty). |
| `buildershq.codex.enabled` | `true` | Track OpenAI Codex session activity. |
| `buildershq.codex.transcriptPath` | `""` | Override Codex sessions directory (auto-detected if empty). |
| `buildershq.sharedEnvFilePath` | `""` | Path to a `.env` file supplying `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `MONGODB_URI` for device-flow login and MongoDB persistence. Leave empty to skip. |

## Privacy

BuildersHQ sends heartbeat data **only to the URL configured in `buildershq.serverUrl`**, which defaults to `http://127.0.0.1:3000` (localhost). No data is sent to Anthropic, Microsoft, or any third-party service.

Heartbeat payloads include:

- Presence status (`active`, `idle`, `away`)
- Workspace identifier — a SHA-256 hash of the workspace path (not the path itself)
- Workspace folder name
- Computer hostname
- A random session ID regenerated each time VS Code starts
- **Optional:** GitHub user profile (only when you have logged in)
- **Optional:** Claude Code / Codex activity summaries — tool names, truncated file paths, truncated command names, read from local transcript files on your machine

You can pause tracking at any time via the Command Palette.

## Payload Format

```json
{
  "timestamp": 1700000000,
  "status": "active",
  "reason": "edit",
  "workspaceId": "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  "workspaceName": "my-project",
  "computerName": "my-machine",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "seq": 42,
  "focused": true,
  "client": { "type": "vscode", "version": "1.0.0" },
  "activities": [
    {
      "claudeSessionId": "session-id",
      "seq": 7,
      "type": "running_command",
      "tool": "Bash",
      "command": "npm test",
      "summary": "Running shell command",
      "source": "claude_code"
    }
  ]
}
```

## Development

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

To bump the version before publishing:

```bash
npm run version:bump
```
