---
name: instashare
description: InstaShare — export the current Claude Code chat session to a local JSONL file. The active session is the most recently modified `~/.claude/projects/<slug>/<uuid>.jsonl` for the current working directory; this skill copies it to the cwd in one shell command. Use when the user asks to "export this chat", "save this conversation", "share this session", "give me the chat as a file", "InstaShare this", or similar. Local export only — no uploading.
tools: Bash
---

# InstaShare

Copy the current Claude Code session JSONL to a file in the user's cwd. **Do this in ONE shell call.** No verification reads, no separate Glob — the freshest `.jsonl` mtime in the project's directory is always the active session.

## Run exactly one of these

Pick by platform. Substitute nothing — the script computes the slug itself.

### Windows (PowerShell, via Bash tool's PowerShell mode or `pwsh -Command`)

```powershell
$cwd = (Get-Location).Path
$slug = ($cwd -replace ':', '-' -replace '\\', '-').ToLower()
$projDir = Join-Path $env:USERPROFILE ".claude\projects\$slug"
$src = Get-ChildItem "$projDir\*.jsonl" -ErrorAction Stop |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
$dst = Join-Path $cwd "claude-chat-$($src.BaseName).jsonl"
Copy-Item $src.FullName $dst -Force
Write-Output $dst
```

### macOS / Linux (Bash)

```bash
cwd="$(pwd)"
slug=$(echo "$cwd" | sed 's#/#-#g' | tr '[:upper:]' '[:lower:]')
slug=${slug#-}
src=$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1)
[ -z "$src" ] && { echo "No session files in $HOME/.claude/projects/$slug" >&2; exit 1; }
name=$(basename "$src")
dst="$cwd/claude-chat-$name"
cp "$src" "$dst"
echo "$dst"
```

The command prints the destination path on success. That path **is** the answer.

## After the command runs

1. **Report the destination path** to the user (the printed line).
2. **Optionally mention subagents.** Check `<src-dir>/<src-uuid-no-ext>/subagents/` — if it exists, tell the user how many `agent-*.jsonl` files are there and that they can be copied separately if wanted. Don't bundle them automatically; don't ask permission to skip.
3. **One-line privacy note**: the export contains all tool inputs and outputs verbatim. Suggest reviewing before sharing.

## Rules

- **One shell call.** Do not run a separate Glob, Read, Test-Path, or Get-ChildItem to "verify" the file first. Trust the mtime sort.
- **Do not guess slug case.** The script lowercases — Windows filesystem is case-insensitive, so this matches whichever case the directory was created with.
- **Do not check before overwriting.** If a stale `claude-chat-<uuid>.jsonl` already exists in cwd from a previous run of this skill, overwriting it with a fresh copy of the same session is exactly what the user wants.
- **Do not transform the content.** The export is the raw JSONL exactly as Claude Code wrote it. If the user asks for a "clean" or "readable" version, tell them that's out of scope and stop.
- **Do not redact.** The user is responsible for reviewing before sharing.
- **Do not upload.** No gists, no pastebins, no buildershq endpoint. Local file only.
