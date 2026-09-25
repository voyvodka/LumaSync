# LumaSync — Agent Instructions

Native desktop app (Tauri 2 + React 19) that mirrors the screen to LED strips, WLED and Philips Hue
in real time, fully locally.

**Read `CLAUDE.md` first.** It is the main context source for this repository: architecture,
commands, code style, verification, release rules and constraints, plus a pointer to
`docs/architecture/README.md`, which indexes the technical reasoning by area. This file exists only
so that tools looking for `AGENTS.md` land in the right place.

The Claude Code–specific section at the end of `CLAUDE.md` (consultant agents and skills under
`.claude/`, which is not committed) does not apply to other tools; everything above it does.

Do not duplicate project context into this file. One source, one place to keep current.
