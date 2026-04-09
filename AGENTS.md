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
