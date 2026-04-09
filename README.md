# LumaSync

[![CI](https://github.com/voyvodka/lumasync/actions/workflows/ci.yml/badge.svg)](https://github.com/voyvodka/lumasync/actions/workflows/ci.yml)
[![Release](https://github.com/voyvodka/lumasync/releases/latest/badge.svg)](https://github.com/voyvodka/lumasync/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS | Windows | Linux](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#platform-support)

LumaSync is a tray-first desktop app that synchronizes WS2812B LED strips with screen content and controls Philips Hue entertainment areas — all from a single compact interface.

It combines a React + TypeScript frontend with a Rust/Tauri runtime to keep the UI responsive while handling native desktop behavior.

## Features

- **Ambilight**: real-time screen capture drives LED strips and/or Hue lights simultaneously
- **Philips Hue**: DTLS 1.2 PSK entertainment streaming, channel position editor, zone auto-derivation from room map
- **Room map editor**: drag-and-drop canvas with furniture, TV anchor, and USB strip objects; Hue channels overlaid on normalized coordinates
- **Solid color**: RGB + brightness push to USB and Hue with debounced 50 ms update
- **LED calibration**: edge counts, gap, corner ownership, start anchor, direction — persisted per layout
- **Target-aware pipeline**: choose USB, Hue, or both per mode; hot-plug detection with suggestion banner
- **Tray-first UX**: single window hidden to tray on close; full control without cluttering the desktop
- **Auto-updater**: GitHub Releases with minisign signature verification

## Tech Stack

- Frontend: Vite, React 19, TypeScript (strict), Tailwind CSS
- Desktop runtime: Tauri v2, Rust
- Testing: Vitest + Testing Library, Cargo test
- Package manager: pnpm

## Supported Hardware

### USB Controllers

Microcontrollers using the following USB-to-serial chips are supported:

| Chip | USB ID |
|------|--------|
| CH340 | `1A86:7523` |
| FTDI FT232 | `0403:6001` |

Baud rate: 115200 (Adalight-compatible protocol).

### Philips Hue

- Hue Bridge (gen 2+) on the local network
- At least one configured **Entertainment Area** in the Hue app
- macOS only: `macos-private-api` is required for fullscreen calibration overlays — the app requests this automatically

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Full support | Primary development target. `macos-private-api` enabled for fullscreen overlays. |
| Windows | Supported | USB and Hue features work. Fullscreen overlay behavior may vary. |
| Linux | Experimental | Requires GTK 3, WebKitGTK 4.1, and `libudev`. Tray behavior depends on desktop environment. |

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 10+
- Rust toolchain (stable)
- Tauri platform prerequisites for your OS

### Install

```bash
pnpm install
```

### Development

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

## Common Scripts

- `pnpm dev`: run web-only Vite dev server
- `pnpm tauri dev`: run desktop app in development mode
- `pnpm typecheck`: run TypeScript type checks (no emit)
- `pnpm lint`: alias for typecheck
- `pnpm vitest run`: run frontend unit tests once
- `pnpm vitest`: run frontend tests in watch mode
- `pnpm verify:shell-contracts`: validate Rust command handlers match frontend contract definitions
- `pnpm check:rust`: run Rust `cargo check`
- `pnpm check:all`: run JS + Rust + shell contract checks together

## Project Structure

- `src/`: React application and feature modules
- `src/shared/contracts/`: cross-layer contract definitions
- `src-tauri/src/commands/`: Rust Tauri command handlers
- `docs/`: debugging and manual operational docs

## Documentation

- Debugging guide: `docs/debugging.md`
- Contributing guide: `CONTRIBUTING.md`
- Code of Conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Support guide: `SUPPORT.md`
- Changelog: `CHANGELOG.md`

## Contributing

Contributions are welcome. Please read `CONTRIBUTING.md` before opening a pull request.

## Security

If you discover a security issue, please follow the process in `SECURITY.md`.

## License

[MIT](LICENSE) © 2026 voyvodka
