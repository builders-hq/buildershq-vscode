# WeekendMode VS Code Extension

## What is this?

A VS Code extension that tracks developer presence and sends heartbeats to the WeekendMode web app (`c:\appmakers\weekendmode`). Shows up as a desk in the virtual office.

## Key Concepts

### Identity
- **sessionId**: Random UUID generated per extension activation. Changes on restart.
- **workspaceId**: SHA-256 hash of the first workspace folder path. Stable per project.
- **computerName**: `os.hostname()`. Stable per machine. **This is the aggregation key** — the web app groups all sessions with the same `computerName` into one person/desk.
- **presenceKey**: `{sessionId}:{workspaceId}` — server-side composite key. One Elasticsearch document per presenceKey.

### Heartbeat
- Sends to `http://127.0.0.1:3000/api/presence` (localhost only)
- Active: every 30s. Idle (5min inactive): every 60s. Away (15min inactive): every 60s.
- Payload: status, reason, workspaceId, workspaceName, repoName, computerName, sessionId, seq, focused, activities[], client info
- Retry with exponential backoff: [1s, 2s, 5s, 10s, 30s]

### Status Transitions
- **Active**: User typed, edited, saved, or switched editor recently
- **Idle**: Inactive for 5 minutes (`idleAfterSeconds`)
- **Away**: Inactive for 15 minutes (`awayAfterSeconds`)
- Window unfocus does NOT trigger instant away — Claude activity keeps presence active

### Claude Code Activity Tracking
- Watches JSONL transcript files in `~/.claude/projects/[workspace-slug]/`
- Parses assistant message content blocks to classify activity type
- Tool classifications: Read, Glob, Edit, Write, Bash, Grep, Task, WebSearch, WebFetch
- Batches up to 10 events per 1000ms
- Activities expire after 10 minutes (not sent in subsequent heartbeats)
- Enabled by default, configurable via settings
- Activity source: `"claude_code"`

### Git Commit Tracking
- Watches `.git/refs/heads/` and `.git/HEAD` via `fs.watch`
- Runs `git log -1` on change to extract short hash, subject, branch
- Debounced 500ms; initial hash seeded on startup to avoid false positives
- Sent as activities with source: `"git"`, type: `"editing"`, summary: `"Committed: {subject}"`
- Enabled by default, configurable via settings

## Project Structure

```
src/
├── extension.ts          # Activation: creates sessionId, starts all services
├── heartbeat.ts          # HTTP client sending presence payloads with retry
├── presence.ts           # User activity tracking, status transitions
├── workspace.ts          # Workspace identity: workspaceId, git repo resolution
├── claudeWatcher.ts      # Claude Code transcript file watcher + parser
├── gitWatcher.ts         # Git commit watcher via .git/refs fs.watch
└── statusBar.ts          # VS Code status bar item showing connection state
```

## Gotchas

- `computerName` is the only field shared across multiple VS Code instances from the same person. The web app uses it to aggregate sessions into one desk.
- `sessionId` is ephemeral (new UUID on each activation). Don't use it as a stable user identifier.
- The extension only talks to localhost:3000. The web app must be running locally for heartbeats to work.
