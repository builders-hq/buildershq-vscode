# BuildersHQ VS Code Extension

## What is this?

A VS Code extension that tracks developer presence and sends heartbeats to a BuildersHQ server.

## Key Concepts

### Identity

- `sessionId`: random UUID generated per extension activation.
- `workspaceId`: SHA-256 hash of the first workspace folder path.
- `computerName`: `os.hostname()`. This is the aggregation key for "same desk" grouping.
- `presenceKey`: `{sessionId}:{workspaceId}` (server-side composite key).

### Heartbeat

- Endpoint: `https://buildershq.net/api/presence` (default, configurable via `buildershq.serverUrl`)
- Interval:
  - Active: every 30 seconds.
  - Idle/Away: every 60 seconds.
- Payload includes status, reason, workspace identity, machine identity, sequencing, focus, and optional `activities[]`.
- Retries use exponential backoff: `1s, 2s, 5s, 10s, 30s`.

### Status transitions

- `active`: recent edit/save/focus/editor activity.
- `idle`: no activity for `idleAfterSeconds` (default 300s).
- `away`: no activity for `awayAfterSeconds` (default 900s).

### Claude Code activity tracking

- Watches `~/.claude/projects/[workspace-slug]/*.jsonl`.
- Parses assistant content blocks and classifies tool usage:
  - `Read`, `Glob`, `Edit`, `Write`, `Bash`, `Grep`, `Task`, `WebSearch`, `WebFetch`.
- Extracts per-record metadata from transcript lines:
  - `gitBranch`: the git branch active when the record was written.
  - `slug`: conversation name (e.g., `jaunty-crunching-wreath`).
  - `isSidechain`: `true` when the record comes from a sub-agent (Task tool).
- Activities are keyed by `claudeSessionId` — one activity block per session.
- Detects both Claude Code CLI and the Claude AI VS Code extension (same transcript format).
- Source in payload: `"claude_code"`.
- Enabled by default (`buildershq.claudeCode.enabled`).

### OpenAI Codex activity tracking

- Watches `~/.codex/sessions/**/*.jsonl` (or `buildershq.codex.transcriptPath` override).
- Tracks only sessions whose `cwd` matches the current workspace.
- Parses:
  - `response_item` / `function_call` for tool activity.
  - `event_msg` / `agent_reasoning` for thinking activity.
- Source in payload: `"codex"`.
- Enabled by default (`buildershq.codex.enabled`).

### Opencode activity tracking

- Watches `~/.local/share/opencode/storage/` for session and message JSON files.
- Scans `session/<project-id>/ses_*.json` to find sessions matching the current workspace via `path.cwd`.
- Watches `message/<session-id>/` directories for new `msg_*.json` files.
- Parses message JSON for role (`user`/`assistant`), tool use blocks, model, and token counts.
- Classifies tools heuristically by name (read, edit, bash, grep, etc.).
- Source in payload: `"opencode"`.
- Enabled by default (`buildershq.opencode.enabled`).
- Override path: `buildershq.opencode.transcriptPath`.

### Gemini CLI activity tracking

- Watches `~/.gemini/tmp/<project_hash>/chats/session-*.json`.
- `<project_hash>` is SHA-256 of the workspace root path (auto-scoped to project).
- Session files are monolithic JSON arrays of Gemini API Content objects (`[{ role, parts }]`).
- Detects `functionCall` parts for tool activity (`read_file`, `write_file`, `run_shell_command`, etc.).
- Tracks message count delta to detect new messages (file is rewritten on each turn).
- Source in payload: `"gemini"`.
- Enabled by default (`buildershq.gemini.enabled`).
- Override path: `buildershq.gemini.transcriptPath`.

### Aider activity tracking

- Watches `.aider.chat.history.md` in the workspace root (append-only Markdown).
- Uses byte-offset streaming (same as JSONL watchers) to detect new content.
- Parses Markdown structure:
  - `#### <text>` lines → user prompts or `/commands`.
  - `<<<<<<< SEARCH` / code blocks → editing activity.
  - Everything else → assistant thinking.
- Source in payload: `"aider"`.
- Enabled by default (`buildershq.aider.enabled`).
- Override path: `buildershq.aider.transcriptPath`.

### Git commit tracking

- Watches `.git/refs/heads/` and `.git/HEAD` using `fs.watch`.
- Runs `git log -1` on change to get hash, subject, branch.
- Sends activity source `"git"` with summary `Committed: {subject}`.
- Enabled by default (`buildershq.gitCommits.enabled`).

## Project Structure

```text
src/
|- extension.ts      # Activation, wiring, commands, configuration handling
|- heartbeat.ts      # HTTP heartbeats + retry/backoff + activity payloads
|- presence.ts       # Presence state machine and editor/focus event tracking
|- workspace.ts      # Workspace identity and repository metadata
|- claudeWatcher.ts  # Claude transcript watcher/parser
|- codexWatcher.ts      # Codex sessions watcher/parser
|- opencodeWatcher.ts   # Opencode sessions watcher/parser
|- geminiWatcher.ts     # Gemini CLI sessions watcher/parser
|- aiderWatcher.ts      # Aider chat history watcher/parser
|- gitWatcher.ts        # Git refs watcher
`- statusBar.ts         # Status bar UI state
```

## Gotchas

- `computerName` is the stable cross-session identity for desk aggregation.
- `sessionId` is ephemeral. Do not use it as a stable person identifier.
- The default endpoint is `https://buildershq.net/api/presence`. Users can override with `buildershq.serverUrl` to point at a self-hosted server.
