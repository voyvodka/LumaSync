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
pnpm install
```

### 2) Run the app

```bash
pnpm tauri dev
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
pnpm typecheck
```

Frontend tests (targeted):

```bash
pnpm vitest run src/features/<feature>
```

Rust checks (if Rust/Tauri touched):

```bash
pnpm check:rust
```

Contract checks (if shell/contracts touched):

```bash
pnpm verify:shell-contracts
```

Integration confidence:

```bash
pnpm build
```

## Workflow

1. Fork the repository and clone your fork.
2. Create a feature branch from `main` (e.g. `feat/my-feature`).
3. Make your changes, following the code style and commit guidance below.
4. Push your branch and open a pull request against `main`.

## Pull Request Guidelines

- Use a clear title describing the intent.
- Explain the problem and why the change is needed.
- List the main files touched.
- Include verification steps and results.
- Keep unrelated cleanup out of the PR.

## Review Process

- A maintainer will review your PR and may request changes.
- Address feedback by pushing new commits (do not force-push during review).
- Once approved, a maintainer will merge the PR.

## Commit Message Guidance

Use concise, intent-first messages.

Use a conventional commit type prefix with a scope matching the affected area.

Examples:

- `fix(tray): prevent duplicate tray icon creation on startup`
- `feat(calibration): add template validation for edge segments`
- `docs(debug): expand debugging guide with focused shell checks`
- `chore(deps): bump frontend dependencies`

Common scopes: `tray`, `hue`, `serial`, `calibration`, `mode`, `ui`, `deps`, `ci`, `debug`.

## Reporting Issues

When opening an issue, include:

- What you expected
- What happened instead
- Reproduction steps
- OS version and environment details
- Logs or screenshots when relevant

## Code of Conduct

By participating, you agree to follow `CODE_OF_CONDUCT.md`.
