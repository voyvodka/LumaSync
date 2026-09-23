# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
Project context — architecture, commands, code style, verification, release rules, constraints — lives
in `AGENTS.md`, shared with other coding agents. This file adds only Claude Code–specific routing.

@AGENTS.md

## Agent Routing

This project uses specialist agents in `.claude/agents/`. They are the primary authority for their domains. The main assistant is an **orchestrator**, not an inline worker.

**`.claude/` is not committed.** The agents and skills named below exist on the maintainer's machine only, so a fresh clone has none of them and this section describes nothing it can reach. If you are working without them, the routing below is still a useful map of which domains need care — just do the work directly, and treat the constraints in `docs/architecture/` as the authority the agents would have cited.

### Routing rules

For any non-trivial task, **spawn the relevant specialist agent(s) instead of working inline.** "Non-trivial" means anything that:

- plans or designs work (roadmap, phase, feature, refactor)
- edits code beyond a one-line fix or rename
- touches `src-tauri/`, `src/features/`, `src/shared/contracts/`, `.github/workflows/`, `CHANGELOG.md`, `SECURITY.md`, version files
- spans more than one domain (Hue + UI, contract + Rust, etc.)
- proposes adding a new dependency, partnership, or integration
- prepares a release or a PR

For multi-domain work, **spawn relevant agents in parallel**, then synthesize their outputs. Never serialize what can run concurrently.

### Inline work is allowed only for

- One-line clarifications or factual questions answered from a single file read
- Typo fixes, identifier renames, pure string edits
- Conversational back-and-forth during the **design discussion phase**, before any code is written. The maintainer prefers to settle a UI direction in conversation first; jumping straight to an implementation means discarding it.

If in doubt, spawn the agent. The token cost of a redundant spawn is trivial compared to the cost of missing an expert-flagged blind spot.

### Agent map

| Trigger | Agent |
|---|---|
| Planning a phase / milestone / multi-domain feature | Spawn the relevant domain agents in parallel, then synthesize |
| Tauri command / status-code / contract change (FIRST, before any implementation) | `contract-architect` |
| Persisted-state shape change / `migrations.ts` / new `ShellState` field | `contract-architect` |
| Hue CLIP v2 / DTLS / entertainment streaming / bridge / 403 re-pair | `hue-expert` |
| USB serial / WS2812B / Adalight / WLED / OpenRGB / firmware / `LedSink` | `device-serial-expert` |
| Rust backend / Tauri config / capture pipeline / tray / platform / CI | `tauri-expert` |
| React components / Tailwind / amber Rev 07 design language / compact mode / a11y / i18n | `ui-ux-expert` |
| New tests / test strategy / coverage gaps / Vitest / cargo test | `test-expert` |
| Dev IPC mock (`mock/`) / WDIO e2e (`e2e/`) | `test-expert` |
| PR review / release readiness / CHANGELOG / Conventional Commits / license / secrets audit | `opensource-guardian` |
| New or bumped dependency / Dependabot / CI workflow or branch-protection change | `opensource-guardian` (with `tauri-expert` for workflow edits) |
| "X.Y.Z atıyorum" / "release hazırla" / "new version" | `release-manager` |

### Standing maintenance duties

These hold in **every** session, not only planning ones. Nobody invokes a command to trigger them.

- **Judge the specialist output you receive.** A subagent's answer is a draft, not a verdict. If it reads thin, contradicts the code, or is shallower than the task deserved, say so plainly instead of passing it on — then offer to send a focused agent to verify or redo that specific part. Ask before spawning; do not fan out.
- **Keep the tooling current.** The agent and skill definitions under `.claude/`, dependency and toolchain updates, and newly available models all drift out of date silently. Raise it when noticed, in a sentence, rather than opening a project.
- **Watch runtime cost.** The capture-to-output path has a per-frame budget. Treat a regression in it as a defect, not a tuning matter.

Spend tokens in proportion to what is at stake. One targeted agent against a specific doubt beats a
broad re-review, and noticing out loud costs nothing at all.

### Runtime debugging — invoke `debug-runtime` BEFORE spawning agents

When the user reports a runtime symptom that cannot be diagnosed from code
alone — UI hangs, crashes, mode transitions misbehaving, capture failures,
Hue/USB anomalies, shutdown deadlocks — invoke the `debug-runtime` skill
first via the Skill tool (or run `/debug-runtime "<problem>"` if the user
typed it). The skill restarts a clean dev session, captures both frontend
(via the console bridge in `src/main.tsx`, which forwards into `tauri-plugin-log`) and backend logs into a
single file, runs the validation suite, and either applies a small inline
fix or hands the captured `/tmp/lumasync-debug-window.log` excerpt to the
right specialist with file:line citations. Skipping this step and
spawning a specialist on hypothesis means the agent re-discovers what the
runtime would have proven in 30 seconds.

Skip the skill only when the bug is already proven by a stack trace or a
failing test in this conversation — re-running the app for evidence we
already have wastes a warm-up cycle.

## Release trigger

Triggered by "X.Y.Z atacağım" / "yeni versiyon" / "release hazırla" → spawn
`release-manager`, which owns the full procedure. The `ls-ci-release-standards`
skill is the single source for CI steps, the readiness checklist, CHANGELOG style, and how
publication works. Do not re-derive any of it here; the rules that must hold regardless of who does
the work are under **Release Workflow** in `AGENTS.md`.
