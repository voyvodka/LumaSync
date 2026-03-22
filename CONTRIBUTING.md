# Contributing to LumaSync

Thanks for considering a contribution.
This guide helps you contribute in a way that keeps the codebase stable and maintainable.

## Ground Rules

- Keep changes focused and minimal.
- Preserve existing architecture and naming patterns.
- Do not introduce new dependencies unless clearly necessary.
- Update tests and docs when behavior changes.

## Development Setup

### 1) Install dependencies

```bash
yarn install
```

### 2) Run the app

```bash
yarn tauri dev
```

## Code Style Expectations

- TypeScript strict-safe code, avoid `any` unless unavoidable.
- Prefer explicit domain types/interfaces for payloads and state.
- Keep non-UI logic in feature state/model files.
- Use functional React components and hooks.
- Keep Rust command payloads strongly typed and frontend-compatible.

## Recommended Local Checks

Run only what is relevant to your change.

```bash
yarn typecheck
```

Frontend tests (targeted):

```bash
yarn vitest run src/features/<feature>
```

Rust checks (if Rust/Tauri touched):

```bash
yarn check:rust
```

Contract checks (if shell/contracts touched):

```bash
yarn verify:shell-contracts
```

Integration confidence:

```bash
yarn build
```

## Pull Request Guidelines

- Use a clear title describing the intent.
- Explain the problem and why the change is needed.
- List the main files touched.
- Include verification steps and results.
- Keep unrelated cleanup out of the PR.

## Commit Message Guidance

Use concise, intent-first messages.

Examples:

- `fix: prevent duplicate tray icon creation on startup`
- `feat: add calibration template validation for edge segments`
- `docs: expand debugging guide with focused shell checks`

## Reporting Issues

When opening an issue, include:

- What you expected
- What happened instead
- Reproduction steps
- OS version and environment details
- Logs or screenshots when relevant

## Code of Conduct

By participating, you agree to follow `CODE_OF_CONDUCT.md`.
