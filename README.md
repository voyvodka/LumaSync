# LumaSync

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
- Package manager: Yarn

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

## Getting Started

### Prerequisites

- Node.js 20+
- Yarn 1.x (classic)
- Rust toolchain (stable)
- Tauri platform prerequisites for your OS

### Install

```bash
yarn install
```

### Development

```bash
yarn tauri dev
```

### Build

```bash
yarn tauri build
```

## Common Scripts

- `yarn dev`: run web-only Vite dev server
- `yarn tauri dev`: run desktop app in development mode
- `yarn typecheck`: run TypeScript type checks (no emit)
- `yarn lint`: alias for typecheck
- `yarn vitest run`: run frontend unit tests once
- `yarn vitest`: run frontend tests in watch mode
- `yarn verify:shell-contracts`: validate Rust command handlers match frontend contract definitions
- `yarn check:rust`: run Rust `cargo check`
- `yarn check:all`: run JS + Rust + shell contract checks together

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
