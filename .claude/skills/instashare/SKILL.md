---
name: instashare
description: InstaShare — upload the current Claude Code chat session to instashare.app and return a public share link. The active session is the most recently modified `~/.claude/projects/<slug>/<uuid>.jsonl`; this skill POSTs that file to the InstaShare API in one shell call and prints the returned URL. Use when the user asks to "share this chat", "make a link to this conversation", "InstaShare this", "publish this session", or similar.
tools: Bash
---

# InstaShare

Upload the current Claude Code session JSONL to the InstaShare API and report the public link. **Do this in ONE shell call.** No verification reads, no separate Glob — the freshest `.jsonl` mtime in the project's directory is always the active session.

## Configuration

Endpoint defaults to `https://instashare.to`. Override with the `INSTASHARE_API_URL` env var (use `http://localhost:3000` for local dev).

## Run exactly one of these

Pick by platform. Substitute nothing — the script computes the slug itself, finds the session, uploads, and prints the URL.

### Windows (PowerShell)

```powershell
$apiBase = if ($env:INSTASHARE_API_URL) { $env:INSTASHARE_API_URL } else { 'https://instashare.to' }
$cwd = (Get-Location).Path
$slug = ($cwd -replace ':', '-' -replace '\\', '-').ToLower()
$projDir = Join-Path $env:USERPROFILE ".claude\projects\$slug"
$src = Get-ChildItem "$projDir\*.jsonl" -ErrorAction Stop |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
$body = Get-Content $src.FullName -Raw -Encoding UTF8
$resp = Invoke-RestMethod -Uri "$apiBase/api/chats" -Method Post `
  -Body $body -ContentType 'text/plain; charset=utf-8'
Write-Output $resp.url
```

### macOS / Linux (Bash)

```bash
api_base="${INSTASHARE_API_URL:-https://instashare.to}"
cwd="$(pwd)"
slug=$(echo "$cwd" | sed 's#/#-#g' | tr '[:upper:]' '[:lower:]')
slug=${slug#-}
src=$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1)
[ -z "$src" ] && { echo "No session files in $HOME/.claude/projects/$slug" >&2; exit 1; }
curl -sS -X POST "$api_base/api/chats" \
  -H 'Content-Type: text/plain; charset=utf-8' \
  --data-binary "@$src" | python3 -c 'import sys, json; print(json.load(sys.stdin)["url"])'
```

The command prints the public URL on success. That URL **is** the answer.

## After the command runs

1. **Report the URL** to the user. Keep it terse — one line with the URL clickable.
2. **One-line privacy reminder**: the chat is now public to anyone with the link. The transcript contains all tool inputs and outputs verbatim (file contents read, command outputs, etc.). Suggest reviewing if anything sensitive is in there.

## Rules

- **One shell call.** Do not run a separate Glob, Read, or pre-flight check. Trust the mtime sort.
- **Do not lowercase-guess the slug or try alternate cases.** Windows filesystem is case-insensitive; the script's lowercased slug matches either casing of the directory.
- **Do not transform the content.** Upload the raw JSONL as-is.
- **Do not redact.** Tell the user about the privacy note; they decide.
- **Do not save a local copy.** The original session file stays where it is; we only POST its contents.
