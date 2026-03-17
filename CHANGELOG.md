# Changelog

All notable changes to BuildersHQ will be documented in this file.

## [1.0.35] - 2026-03-16

### Added
- GitHub PR watcher for room event tracking (PR opened/merged)
- PR close, branch create/delete events in room activity feed
- Debug logging for git/github event pipeline

### Fixed
- Encoding issue in heartbeat.ts
- Suspend heartbeats after 2 hours of away status

## [1.0.0] - 2026-02-27

### Added

- Presence detection with automatic `active`, `idle`, and `away` state transitions.
- Heartbeat reporting to a configurable endpoint with exponential backoff retry.
- Status bar indicator showing current presence state with pause/resume support.
- Claude Code activity tracking from `~/.claude/projects/` JSONL transcripts.
- OpenAI Codex activity tracking from `~/.codex/sessions/` JSONL transcripts.
- Git commit activity tracking via `.git/refs` file watching.
- GitHub authentication via VS Code's built-in account provider or device flow fallback.
- Optional MongoDB persistence for heartbeat payloads.
- `buildershq.serverUrl` setting for configuring the presence API endpoint.
