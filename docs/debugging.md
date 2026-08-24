# LumaSync Debugging Guide

## 1) Baseline run

```bash
bun run tauri dev
```

- Frontend runtime errors appear in the webview console.
- Rust/Tauri errors appear in the terminal that started `bun run tauri dev`.

## 2) Open webview devtools

- macOS shortcut: `Cmd + Option + I`
- Or right click in window and open inspector (if available in dev mode).

Use the Console tab for React/i18n/tray bridge logs.

## 3) Increase Rust/Tauri log verbosity

```bash
RUST_LOG=info bun run tauri dev
```

For more detail:

```bash
RUST_LOG=debug bun run tauri dev
```

## 4) Useful focused checks

```bash
node scripts/verify/phase01-shell-contracts.mjs
```

This confirms shell contracts and baseline IDs are intact.

## 5) Quick triage flow

1. Reproduce once with `bun run tauri dev`
2. Check terminal (Rust/Tauri side)
3. Check DevTools Console (frontend side)
4. If tray behavior is involved, run `docs/manual/phase-01-tray-checklist.md`
