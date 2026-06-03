---
name: instashare
description: InstaShare — export the current Claude Code chat session to a local JSONL file. Claude Code persists every session under ~/.claude/projects/<project-slug>/<session-uuid>.jsonl; this skill locates that file and copies it somewhere accessible. Use when the user asks to "export this chat", "save this conversation", "share this session", "give me the chat as a file", "InstaShare this", or similar. Local export only — no uploading.
tools: Read, Glob, Bash
---

# InstaShare

Copies the current Claude Code session's raw JSONL transcript to a file in the user's working directory (or a path they specify), so it can be shared, archived, or pasted elsewhere.

## How Claude Code stores chats

Every session is persisted live to:

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

- One JSON record per line: `user`, `assistant`, `attachment`, `system`, `file-history-snapshot`, `permission-mode`, `ai-title`, `bridge-session`, `last-prompt`.
- Assistant turns include `text`, `tool_use`, and `thinking` content blocks. Tool results come back as `user` records with a `tool_result` content block.
- The `<project-slug>` is derived from the cwd (e.g. `C:\appmakers\buildershq-vscode` → `c--appmakers-buildershq-vscode`). Capitalization is sometimes preserved, sometimes not — don't try to compute the slug; find it by directory listing instead.
- Sub-agent (Task tool) transcripts live in `<session-uuid>/subagents/agent-*.jsonl` next to the main file.
- The **active** session is the most recently modified `.jsonl` in the project's directory — it's being appended to in real time.

## Steps

### 1. Locate the current session file

Use Glob to find `.jsonl` files under `~/.claude/projects/`. Glob returns results sorted by modification time, so the freshest entry is the live session.

Strategy:
- First try to match the project: glob `~/.claude/projects/*/` and pick the directory whose name corresponds to the current cwd (case-insensitive, with `:` and path separators collapsed to `-`).
- Then glob `<that-dir>/*.jsonl` — the first result is the current session.
- If the project directory cannot be identified, glob `~/.claude/projects/**/*.jsonl` and take the most recently modified file across all projects (that's almost certainly the current session).

Confirm you have the right file by `Read`ing the first few lines and checking the embedded `cwd` and `sessionId` fields match the current environment.

### 2. Determine the destination

- Default: `<cwd>/claude-chat-<session-uuid>.jsonl` (the UUID is the source filename without `.jsonl`).
- If the user provided a path or directory in their request, honor it.
- Don't overwrite an existing file without asking.

### 3. Copy the file

Use Bash `cp` on Unix or `Copy-Item` on Windows. A plain file copy is sufficient — the JSONL is self-contained.

### 4. Handle sub-agent transcripts

Check whether `<session-uuid>/subagents/` exists alongside the main JSONL. If yes, tell the user how many `agent-*.jsonl` files are present and ask whether to bundle them too (copy the whole `subagents/` folder next to the exported main file).

### 5. Report back

Tell the user:
- The absolute path of the exported file (and the subagents folder, if copied).
- The session UUID and approximate line count, so they know what they have.
- A one-line privacy reminder: the export contains tool inputs and outputs verbatim, including any file contents read during the session and any values surfaced by Bash commands. Suggest they review before sharing publicly.

## What this skill does NOT do

- It does not upload anywhere. No gists, no pastebins, no buildershq endpoint. Local file only.
- It does not transform the content — the export is the raw JSONL exactly as Claude Code wrote it. (If the user asks for a "clean" or "readable" version, that's out of scope here; tell them and stop.)
- It does not redact sensitive values. The user is responsible for reviewing before sharing.
