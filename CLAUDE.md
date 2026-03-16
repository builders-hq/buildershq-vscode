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

### Delayed identification (anonymous mode)

- Tracking starts immediately on activation, even without GitHub login.
- Every heartbeat includes the persistent `machineToken` (UUID stored in SecretStorage) as the stable machine identity — regardless of authentication state. The server uses this for machine correlation, desk grouping, and claim-token delivery.
- On activation, `restoreSession()` silently checks for an existing VS Code GitHub session (`createIfNone: false, silent: true`). If the user has previously signed into GitHub in VS Code (for any extension), their profile is included in heartbeats alongside `machineToken` — even without a BuildersHQ JWT.
- The login suggestion notification is only shown when there is no GitHub identity at all. Users who already have a VS Code GitHub session are not nagged.
- Anonymous heartbeats (no GitHub identity) are sent with `computerName` + `machineToken` as identifiers and no `Authorization` header.
- The status bar shows `Active $(link)` with a tooltip prompting login while in anonymous mode.
- If the server rejects anonymous heartbeats (401 without a token), the extension stays running and shows "Not Connected" — it does not aggressively prompt for login.

### Reverse identification (website-initiated login)

Two mechanisms allow the user to identify from the BuildersHQ website:

1. **`vscode://` URI redirect (primary, most secure):**
   - User logs in on buildershq.net → website shows "Connect VS Code" button.
   - Clicking it opens `vscode://buildershq/auth-callback?code=XXXXX` (one-time code).
   - The extension's existing URI handler redeems the code → tokens stored → identified.
   - Uses the `onIdentified` callback when no `pendingBrowserLogin` promise exists.
   - Secure: `vscode://` targets only the local machine, one-time code over HTTPS.

2. **Heartbeat response piggyback (automatic, secondary):**
   - When the server recognizes a `machineToken` has been claimed (user logged in on website), it includes a `claimToken` (JWT + refresh token + user profile) in the heartbeat response.
   - The extension parses the response body only when anonymous (no access token), validates the `claimToken` structure, and calls `acceptClaimToken()` on the auth service.
   - Secure: `machineToken` is a random UUID stored in SecretStorage — cannot be guessed from `computerName`.
   - Idempotent: three layers prevent duplicate processing (no body parse when authenticated, guard in `acceptClaimToken`, guard in callback).

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

### GitHub PR tracking

- Polls GitHub REST API every 60s for recent PRs (`/repos/{owner}/{repo}/pulls?state=all&sort=updated`).
- Uses the raw GitHub access token from `GitHubAuthService.getGitHubAccessToken()`.
- Uses conditional requests (`If-None-Match` / ETag) to minimize rate limit consumption.
- Seeds current PR state on startup to avoid false events on activation.
- Detects `pr_opened` (new PR not previously seen) and `pr_merged` (PR gained `merged_at`).
- Sends activity with `source: "github"`, `activityType: "pr_opened" | "pr_merged"`, `claudeSessionId: "github:pr:{number}"`.
- The server's heartbeat handler converts these into room events (`pr_opened` / `pr_merged`).
- Enabled by default (`buildershq.githubPr.enabled`).

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
|- githubPrWatcher.ts   # GitHub PR polling (opened/merged detection)
`- statusBar.ts         # Status bar UI state
```

## Gotchas

- `computerName` is the stable cross-session identity for desk aggregation.
- `sessionId` is ephemeral. Do not use it as a stable person identifier.
- The default endpoint is `https://buildershq.net/api/presence`. Users can override with `buildershq.serverUrl` to point at a self-hosted server.
