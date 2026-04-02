# Pi Session Memory Extension

Claude-style session memory for Pi, packaged as a standalone Pi package so it can be installed from a local path or GitHub.

## Features

- Claude-matched default thresholds:
  - `minimumMessageTokensToInit`: `10000`
  - `minimumTokensBetweenUpdate`: `5000`
  - `toolCallsBetweenUpdates`: `3`
- Per-session markdown memory file:
  - `.pi/session-memory/<session-id>/summary.md`
- Claude-derived session memory template and update prompt text
- Pi compaction integration via `session_before_compact`
- Slash commands:
  - `/session-memory-update`
  - `/session-memory-status`

## Install

From GitHub:

```bash
pi install git:github.com/san-tian/pi-session-memory-extension
```

Project-local install:

```bash
pi install -l git:github.com/san-tian/pi-session-memory-extension
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-session-memory-extension
```

## Repository Layout

- `extensions/session-memory/index.ts` - extension lifecycle, thresholds, compaction integration, commands
- `extensions/session-memory/prompts.ts` - Claude-derived template and prompt text with Pi-specific adaptation

## Claude Parity Notes

This package preserves Claude's main session-memory behavior as closely as Pi's public extension API allows:

- delayed session-memory creation
- structured `summary.md` template
- strict template-preserving update instructions
- token and tool-call based update thresholds
- session-memory-first compaction path

Pi does not expose Claude's exact post-sampling hook and forked-agent Edit-only pathway, so this package approximates those parts with Pi's `turn_end` lifecycle plus a direct model completion that returns the full updated markdown file.

## Optional Overrides

If present, these files override the built-in defaults:

- `~/.pi/session-memory/config/template.md`
- `~/.pi/session-memory/config/prompt.md`

## Development

Pi auto-discovers extensions from installed packages via the `pi` manifest in `package.json`.

For quick local testing:

```bash
pi -e ./extensions/session-memory/index.ts
```
