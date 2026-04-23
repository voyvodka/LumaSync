# AGENTS

Agent-agnostic coding rules for this repository. All AI coding assistants (Claude Code, Cursor, Copilot, etc.) should follow these guidelines.

> **Primary reference:** [`CLAUDE.md`](CLAUDE.md) contains the full project specification — architecture, commands, code style, testing, debugging, release workflow, and constraints. This file supplements it with agent-specific behavioral rules.

## Agent Behavior

- Run commands from repository root.
- Prefer minimal, scoped edits; avoid broad refactors unless requested.
- Preserve existing architecture and naming patterns.
- Do not introduce new dependencies unless necessary and justified.
- Use pnpm for all frontend dependency/script execution.
- Do not mix unrelated cleanup into functional changes.
- Keep public API and contract changes explicit in PR/summary notes.
- Run the lightest relevant verification commands first; prefer targeted test runs before full-suite.
- Be explicit about what changed, where, and why. Reference file paths directly.

## Quick Command Reference

See [`CLAUDE.md` → Commands](CLAUDE.md#commands) for the full list.

```bash
pnpm tauri dev              # Dev with hot reload
pnpm typecheck              # TypeScript check
pnpm check:all              # JS + Rust + contracts
pnpm vitest run             # Frontend tests
pnpm verify:shell-contracts # Contract validation
```

## Local UI/UX Reference

For settings IA/UI/UX tasks, consult the local blueprint at `docs/settings-ui-ux-blueprint.local`. This file is gitignored (`*.local`) and serves as current design intent for settings redesign decisions.

## Planning Artifacts

`.planning/` exists on the maintainer's local filesystem only — it is gitignored and **must never be committed, unignored, or distributed**. Agents running in CI, sandboxed environments, or on collaborator clones will not see this directory and should not ask about or rely on its contents.

If the directory is present in your working copy, treat it as the single source of truth for planning context:

- `ROADMAP.md` — master roadmap (milestones, backlog, rejected ideas, known limitations). Read this before proposing any feature work.
- `competitive-research/comparison/<domain>-vs-lumasync.md` — primary source for roadmap gap items. Open the relevant file when the user references a gap by ID (`G1`, `GAP 5`, etc.) or by name.
- Other subdirectories contain scoped research for specific features.

Do not propose changes that assume `.planning/` visibility for anyone other than the local maintainer. Do not write CHANGELOG, commit messages, PR descriptions, or release notes that reference `.planning/` paths — collaborators cannot follow them.

## Hard Constraints (Do Not Violate)

- **macOS private API** (`macos-private-api: true` in `tauri.conf.json`) — required for fullscreen calibration overlays across all displays. Never remove.
- **Hue streaming interval: minimum 50ms (20 Hz max)** — exceeding this throttles or drops the Hue bridge connection.
- **Supported USB chip IDs only**: CH340 (`0x1A86:0x7523`), FTDI (`0x0403:0x6001`). Do not widen serial port discovery beyond these.
- **Window size**: per-mode, see `UI_MODE_SIZES` / `UI_MODE_MIN_SIZES` in `src/shared/contracts/shell.ts`. Full mode 900×620 (min 800×560), compact mode 320×480 (min 300×420). Do not change without explicit instruction.
- **State persistence**: Tauri `plugin-store` → `~/.config/lumasync/app.json`. Keys are defined in `src/shared/contracts/shell.ts` — do not add ad-hoc keys.
- **i18n**: Every user-facing string must have entries in both `src/locales/en/common.json` and `src/locales/tr/common.json`.
- **Contract alignment**: After any change to `src/shared/contracts/` or Rust command handlers, run `pnpm verify:shell-contracts` to confirm they stay in sync.

## Security Guidelines

- Tauri commands never throw — errors are returned as status objects (`{ code, message }`). Always check `status.code`; never assume success from a resolved promise.
- Never log or store Hue API credentials, bridge tokens, or user secrets in plaintext (logs, localStorage, or unencrypted files).
- Auto-update artifacts are verified with minisign — do not bypass or skip signature verification.
- No `eval`, dynamic `require`, or unsanitized shell execution anywhere in frontend or Rust.
- Serial port access is intentionally scoped to the two known USB vendor/product IDs above — do not broaden this without explicit justification.
- Avoid introducing `any` casts in TypeScript that touch security-sensitive paths (auth, persistence, IPC payloads).

## Architecture Summary (for Security/Performance Scans)

```
Frontend (React 19, src/)
  └─ Tauri IPC (invoke) ──→ Rust commands (src-tauri/src/commands/)
                                  ├─ Serial port (USB, 115200 baud)
                                  └─ Philips Hue CLIP v2 REST + DTLS streaming
```

Key data flows to audit:
- `src/features/hue/` → DTLS entertainment streaming, bridge credentials
- `src/features/device/` → USB serial connection, health checks
- `src/features/persistence/` → app state read/write via plugin-store
- `src-tauri/src/commands/` → all IPC boundary handlers
