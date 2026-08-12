# LumaSync — Agent Instructions

A tray-first desktop app (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips,
WLED devices, and Philips Hue entertainment areas in real time — fully local, no cloud.

**Read `CLAUDE.md` first.** It is the main context source for this repository: architecture,
contract-first discipline, commands, code style, testing, debugging, release workflow, and hard
constraints. This file exists only so that tools looking for `AGENTS.md` land in the right place.

For where the project currently stands, read `CHANGELOG.md` and the open issues/PRs
(`gh issue list`, `gh pr list`). The maintainer also keeps private working documents under
`devdocs/`, excluded from git and present only on their machine — never assume it is available,
never reference its paths in commits, PRs, release notes, or **source-code comments**, and never
propose committing it.

Do not duplicate project context into this file. One source, one place to keep current.
