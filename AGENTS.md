# AGENTS

This file defines practical working rules for coding agents in this repository.
Apply these rules when planning, editing, testing, and validating changes.

## 1) Project Snapshot

- App: LumaSync (Tauri + React + TypeScript desktop app)
- Frontend: Vite, React 19, TypeScript strict mode, Tailwind CSS
- Backend/runtime: Rust (Tauri commands in `src-tauri/src/commands`)
- Tests: Vitest (frontend unit tests) + Cargo tests (Rust)
- Package manager: Yarn (use Yarn for frontend tasks)

## 2) Rule Sources Found In Repo

- `.cursor/rules/`: not found
- `.cursorrules`: not found
- `.github/copilot-instructions.md`: not found
- Therefore: use this AGENTS.md + existing code conventions as the effective policy.

## 3) Non-Negotiable Agent Behavior

- Run commands from repository root.
- Prefer minimal, scoped edits; avoid broad refactors unless requested.
- Preserve existing architecture and naming patterns.
- Do not introduce new dependencies unless necessary and justified.
- Use Yarn for frontend dependency/script execution.
- If a task directly matches available personal skills (for example `hb-*`, `sa-*`), use them in the relevant step.
- If planning artifacts are used for context, do not leak internal planning file paths in final user-facing explanations.

## 4) Command Reference

### Setup

- Install deps: `yarn install`
- Frozen install (CI-like): `yarn install --frozen-lockfile`

### Frontend dev/build/check

- Dev server: `yarn dev`
- Type check: `yarn typecheck`
- Lint alias (currently typecheck): `yarn lint`
- Build frontend: `yarn build`
- Preview build: `yarn preview`
- Shell contracts check: `yarn verify:shell-contracts`
- Full JS/Rust checks: `yarn check:all`

### Tauri / desktop runtime

- Run app in dev: `yarn tauri dev`
- Build desktop bundles: `yarn tauri build`
- Rust check only: `yarn check:rust`

### Frontend tests (Vitest)

- Run all tests once: `yarn vitest run`
- Watch mode: `yarn vitest`
- Run a single test file: `yarn vitest run src/App.test.tsx`
- Run a single test by name: `yarn vitest run src/App.test.tsx -t "renders"`
- Run related folder tests: `yarn vitest run src/features/device`

### Rust tests (Cargo)

- Run all Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`
- Run one integration test target:
  `cargo test --manifest-path src-tauri/Cargo.toml --test hue_onboarding_tdd`
- Run one Rust test by name:
  `cargo test --manifest-path src-tauri/Cargo.toml verify_hue_bridge_ip_rejects_invalid_ipv4`

## 5) Where Code Lives

- React app root: `src/main.tsx`, `src/App.tsx`
- Feature modules: `src/features/**`
- Shared contracts/constants: `src/shared/**`
- Test setup: `src/test/setup.ts`
- Rust commands: `src-tauri/src/commands/**`
- Tauri bootstrap: `src-tauri/src/lib.rs`

## 6) TypeScript + React Style Rules

- Use TypeScript strict-safe code; avoid `any` unless unavoidable.
- Prefer explicit domain interfaces/types for API payloads and state.
- Keep runtime normalization in dedicated functions (see `normalize*` patterns).
- Use `const` by default; use `let` only when reassignment is needed.
- Favor small pure helpers for transformation/validation logic.
- Keep components focused; move non-UI logic into feature state/model files.

### Imports

- Group imports as: external packages, then internal modules.
- Keep relative import depth consistent with nearby files.
- Use type-only imports where practical (`import type { Foo } ...`).
- Preserve existing quote style (`"`) and semicolon usage.

### Naming

- Components: PascalCase (`DeviceSection`, `SettingsLayout`).
- Hooks: `useXxx` (`useDeviceConnection`, `useHueOnboarding`).
- Helpers/functions: camelCase (`normalizeOutputTargets`).
- Constants: UPPER_SNAKE_CASE for shared constants and command IDs.
- Prefer descriptive names for status/result objects (`statusModel`, `runtimePlan`).

### React patterns

- Use functional components and hooks.
- Keep side effects inside `useEffect` with accurate dependency arrays.
- Use `useCallback` for handlers passed down to child components.
- For fire-and-forget async calls in handlers/effects, use `void someAsyncCall()`.
- Guard state transitions with explicit checks and early returns.

## 7) Rust/Tauri Style Rules

- Keep command payloads strongly typed with `struct`s and `#[derive(Serialize)]`.
- Use `#[serde(rename_all = "camelCase")]` for frontend-facing payload compatibility.
- Return stable machine-readable status codes plus human-readable messages.
- Prefer deterministic error mapping functions (for example `connect_error_code`).
- Keep command handlers focused; extract reusable helpers for mapping/validation.
- Follow `rustfmt` defaults; do not hand-format against project style.

## 8) Error Handling Conventions

- Do not swallow important failures silently.
- In TS, use `try/catch` around async boundaries that touch IO/runtime commands.
- Log with contextual prefixes (existing pattern uses `[LumaSync] ...`).
- For recoverable failures, keep app responsive and provide safe fallback behavior.
- In Rust, return coded error context via status objects or `Result<_, String>` where already established.
- Prefer explicit fallback values for invalid external input.

## 9) Testing Conventions

- Keep tests close to feature code using `*.test.ts` / `*.test.tsx` naming.
- Use Testing Library + Vitest globals (`describe`, `it`, `expect`, `vi`).
- Mock Tauri/plugin boundaries in frontend tests for deterministic execution.
- For Rust, keep focused behavior tests with clear scenario names.
- Add/adjust tests for changed behavior, not unrelated areas.

## 10) Contracts, i18n, and Data Shapes

- Treat `src/shared/contracts/**` as source-of-truth for cross-layer data shape.
- Preserve command/status code semantics; avoid ad-hoc code strings.
- Keep i18n keys stable and scoped by feature.
- When adding user-visible text, ensure locale files are updated consistently.

## 11) Change Scope and Safety Checklist

- Confirm the minimal set of files needed for the requested change.
- Keep public API and contract changes explicit in PR/summary notes.
- Run the lightest relevant verification commands first.
- Prefer targeted test runs before full-suite runs.
- Do not mix unrelated cleanup into functional changes.

## 12) Suggested Verification Flow For Most Tasks

1. `yarn typecheck`
2. `yarn vitest run <changed-test-or-folder>`
3. `yarn verify:shell-contracts` (if shell/contracts touched)
4. `yarn check:rust` (if Tauri/Rust touched)
5. `yarn build` for integration confidence

## 13) Version Update / Release Preflight

Before any version bump or release preparation, complete this checklist.

### Release intent and scope

- Confirm SemVer level (`major` / `minor` / `patch`) and document why.
- Ensure only release-relevant changes are included (no unrelated cleanup).
- Verify public API, contract, or behavior changes are explicitly documented.

### Required validations

Run the lightest relevant checks first, then broader confidence checks:

1. `yarn typecheck`
2. `yarn vitest run <changed-test-or-folder>`
3. `yarn verify:shell-contracts` (if shell/contracts touched)
4. `yarn check:rust` (if Tauri/Rust touched)
5. `yarn build`

### Documentation and release notes

- Update `CHANGELOG.md` with user-facing changes.
- Verify `README.md`/`docs/**` reflect any workflow or command changes.
- If user-visible text changed, ensure locale updates remain consistent.

### Security and compatibility

- If there is security impact, follow `SECURITY.md` disclosure guidance.
- If contracts/status codes changed, describe compatibility impact and migration notes.

### Final preflight confirmation

- Confirm release summary includes: scope, risk level, validation results, and rollback notes.

## 14) Notes For Agent Output Quality

- Be explicit about what changed, where, and why.
- Reference file paths directly when summarizing edits.
- If a command is skipped, state why it was skipped.
- Keep explanations concise and implementation-focused.

## 15) Local UI/UX Reference Blueprint

- For settings IA/UI/UX tasks, consult the local blueprint at:
  `docs/settings-ui-ux-blueprint.local`
- This file is intentionally local-only (`*.local` is gitignored) and should be treated as the current design intent source for settings redesign decisions.
- When requests involve navigation, card hierarchy, stepper/tab/accordion structure, or settings flow simplification, align proposals and implementation steps with this blueprint first.
