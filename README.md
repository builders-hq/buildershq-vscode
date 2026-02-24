# Vibemap

Presence detection for VS Code. Tracks developer activity and reports status (`active`, `idle`, `away`) to a configurable endpoint.

## Features

- **Activity detection** — monitors edits, saves, editor switches, window focus, debug sessions, and build tasks
- **Presence state machine** — automatically transitions between `active`, `idle`, and `away` based on activity
- **Heartbeat reporting** — sends presence updates at configurable intervals via HTTP POST
- **Status bar indicator** — shows current state at a glance
- **Pause / Resume** — toggle tracking with commands; state persists across restarts
- **Network resilience** — exponential backoff retry on failure, automatic recovery
- **Anti-flapping** — focus debounce and minimum state duration prevent rapid state changes

## Status Bar

| State | Display |
|-------|---------|
| Active | `Vibemap: Active` |
| Idle | `Vibemap: Idle` |
| Away | `Vibemap: Away` |
| Paused | `Vibemap: Paused` |
| Disconnected | `Vibemap: Not Connected` |

## Commands

- **Vibemap: Pause Presence Tracking** — stop sending heartbeats
- **Vibemap: Resume Presence Tracking** — resume sending heartbeats

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibemap.idleAfterSeconds` | `60` | Seconds of inactivity before status becomes idle |
| `vibemap.awayAfterSeconds` | `300` | Seconds of inactivity before status becomes away |
| `vibemap.heartbeatActiveSeconds` | `30` | Heartbeat interval while active |
| `vibemap.heartbeatIdleSeconds` | `120` | Heartbeat interval while idle |

## Privacy

This extension does **not** collect or transmit:

- File names or contents
- Keystrokes
- Terminal commands
- Full file paths

Only the following is sent:

- Timestamps
- Presence state (`active` / `idle` / `away`)
- Activity reason (`edit`, `save`, `focus`, etc.)
- Hashed workspace ID (SHA-256, irreversible)
- Workspace folder name
- Session ID and sequence number

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
    "version": "0.1.0"
  }
}
```

## Development

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host for testing.
