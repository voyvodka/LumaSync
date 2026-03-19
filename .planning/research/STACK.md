# Stack Research

**Domain:** Windows-first, cross-platform desktop Ambilight app (WS2812B over USB serial)
**Researched:** 2026-03-19
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| Tauri | Rust crate `tauri` `2.10.3`, JS `@tauri-apps/api` `2.10.1`, CLI `@tauri-apps/cli` `2.10.1` | Desktop shell, native bridge, packaging | 2025+ standard for low-overhead Rust+web desktop apps; smaller runtime than Chromium-bundled approaches; Windows-first path is well documented with WebView2 and MSVC toolchain | HIGH |
| Rust + Tokio | Rust stable (MSVC), `tokio` `1.50.0` | Real-time capture/serial pipeline, background workers, scheduling | Ambilight needs predictable low-latency loops; Rust gives memory safety and strong perf, Tokio gives structured async orchestration and bounded concurrency | HIGH |
| React + Vite + TypeScript | `react` `19.2.4`, `vite` `8.0.1`, `typescript` `5.9.3` | Settings UI, setup wizard, calibration UX | Fast UI iteration with mature ecosystem; Vite gives rapid dev feedback; TypeScript reduces config/protocol bugs in calibration and profiles | MEDIUM |
| Screen capture backends (dual) | `windows-capture` `1.5.0` (Windows), `xcap` `0.9.2` (cross-platform abstraction path) | Monitor frame capture for Ambilight sampling | Windows-first should use Windows Graphics Capture path for throughput; keep a backend trait and plug `xcap` for Linux/macOS expansion without rewriting app core | MEDIUM |
| USB serial transport | `serialport` `4.9.0` | Auto-detect COM ports, open/read/write LED frames | Cross-platform serial API with port enumeration and USB metadata support; directly aligned with Arduino-like WS2812B controller workflow | HIGH |

### Supporting Libraries

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| `tauri-plugin-store` | Rust `2.4.2`, JS `@tauri-apps/plugin-store` `2.4.2` | Persist profiles/calibration/settings locally | Use for local-first profile persistence in v1 instead of introducing DB complexity early | HIGH |
| `tauri-plugin-log` + `tracing` + `tracing-subscriber` | `tauri-plugin-log` `2.8.0`, `tracing` `0.1.44`, `tracing-subscriber` `0.3.23` | Structured runtime logs for capture/serial failures and long-session diagnostics | Enable from day one; reliability debugging is core for USB disconnect/reconnect and capture drift cases | HIGH |
| `anyhow` | `1.0.102` | Unified error propagation in app core | Use in application/service layer to keep failure paths explicit and simplify user-facing error mapping | HIGH |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Yarn (Corepack) | Frontend dependency and script management | Use Yarn consistently for this repo (`corepack enable` + Yarn lockfile) |
| Tauri CLI | Dev/build/package desktop app | Keep CLI aligned with Tauri v2 (`@tauri-apps/cli` `2.10.1`) |
| rustup + Cargo (stable-msvc) | Rust toolchain and builds on Windows | Tauri recommends MSVC host triple for Windows desktop development |

## Installation

```bash
# Frontend core
yarn add react react-dom @tauri-apps/api @tauri-apps/plugin-store

# Frontend dev tools
yarn add -D @tauri-apps/cli vite typescript @types/react @types/react-dom

# Rust backend/core
cargo add tauri tokio serialport anyhow tracing tracing-subscriber tauri-plugin-store tauri-plugin-log

# Capture backends (compile by target)
cargo add windows-capture
cargo add xcap
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Tauri v2 | Electron | Choose Electron only if team is JS-only and accepts larger memory/binary footprint for faster pure-JS hiring/onboarding |
| Rust `serialport` | Node `serialport` package | Use Node stack only if you already committed to Electron and keep all device logic in JS |
| `windows-capture` + backend abstraction | `xcap` only everywhere | Use only `xcap` if you prioritize one capture API across OSes over best Windows-specific capture performance |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Electron as default for this project | Embeds Chromium + Node in app binary, increasing footprint and idle resource cost for a background tray utility | Tauri v2 with Rust core |
| `windows-capture` `2.0.0-alpha.*` in production | Alpha channel increases integration risk for a reliability-first v1 | `windows-capture` `1.5.0` stable |
| Browser `getDisplayMedia` as main capture path | User-mediated capture UX and browser-centric permission model do not fit always-on desktop tray behavior | Native capture via Rust (`windows-capture`/`xcap`) |
| Network-first LED transport in v1 | Adds failure modes and latency variability; conflicts with validated USB-first project scope | USB serial protocol with robust reconnect logic |

## Stack Patterns by Variant

**If shipping Windows v1 ASAP:**
- Use only `windows-capture` behind a `CaptureBackend` trait.
- Because it minimizes cross-platform complexity while maximizing Windows frame capture reliability.

**If opening Linux/macOS milestone:**
- Keep transport and color pipeline unchanged; add `xcap` implementation for non-Windows targets.
- Because backend-swapping preserves protocol/UI code and prevents rewrite.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `tauri@2.10.3` | `@tauri-apps/api@2.10.1`, `@tauri-apps/cli@2.10.1` | Stay on Tauri v2 family; keep JS/Rust sides in same major line |
| `@tauri-apps/plugin-store@2.4.2` | `@tauri-apps/api@^2.8.0` | Plugin metadata explicitly depends on API v2 range |
| `serialport@4.9.0` | Rust `>=1.59` | README and crate metadata indicate MSRV floor |
| `windows-capture@1.5.0` | Windows targets only | Guard with `cfg(target_os = "windows")` |
| `xcap@0.9.2` | Windows/macOS/Linux | Wayland support exists but has scenario limitations per upstream status table |

## Sources

- Context7 `/tauri-apps/tauri-docs` - Tauri v2 docs, prerequisites, architecture direction (HIGH)
- Context7 `/serialport/serialport-rs` - serial enumeration/open/read/write API patterns (HIGH)
- Context7 `/nashaofu/xcap` - monitor capture/recording API and cross-platform claims (MEDIUM)
- Context7 `/websites/rs_tokio` - `spawn_blocking` and runtime behavior for mixed async/blocking workloads (HIGH)
- https://tauri.app/start/prerequisites/ - Windows toolchain/WebView2 requirements, updated 2026-02-12 (HIGH)
- https://tauri.app - Tauri value proposition (small/fast/cross-platform) (HIGH)
- https://registry.npmjs.org/@tauri-apps%2Fapi/latest - current `@tauri-apps/api` version `2.10.1` (HIGH)
- https://registry.npmjs.org/@tauri-apps%2Fcli/latest - current `@tauri-apps/cli` version `2.10.1` (HIGH)
- https://registry.npmjs.org/@tauri-apps%2Fplugin-store/latest - current plugin-store JS version `2.4.2` (HIGH)
- https://registry.npmjs.org/react/latest - current React version `19.2.4` (HIGH)
- https://registry.npmjs.org/vite/latest - current Vite version `8.0.1` (HIGH)
- https://registry.npmjs.org/typescript/latest - current TypeScript version `5.9.3` (HIGH)
- https://crates.io/api/v1/crates/tauri - current Rust crate `tauri` version `2.10.3` (HIGH)
- https://crates.io/api/v1/crates/serialport - current crate version `4.9.0` (HIGH)
- https://crates.io/api/v1/crates/tokio - current crate version `1.50.0` (HIGH)
- https://crates.io/api/v1/crates/windows-capture - stable `1.5.0`, latest includes alpha `2.0.0-alpha.7` (HIGH)
- https://crates.io/api/v1/crates/xcap - current crate version `0.9.2` (HIGH)
- https://crates.io/api/v1/crates/tauri-plugin-store - current Rust plugin-store `2.4.2` (HIGH)
- https://crates.io/api/v1/crates/tauri-plugin-log - current Rust plugin-log `2.8.0` (HIGH)
- https://crates.io/api/v1/crates/tracing - current `tracing` `0.1.44` (HIGH)
- https://crates.io/api/v1/crates/tracing-subscriber - current `tracing-subscriber` `0.3.23` (HIGH)
- https://crates.io/api/v1/crates/anyhow - current `anyhow` `1.0.102` (HIGH)
- https://www.electronjs.org/docs/latest/ - confirms Electron embeds Chromium + Node.js (HIGH)

---
*Stack research for: Ambilight Desktop (Windows-first, USB serial WS2812B)*
*Researched: 2026-03-19*
