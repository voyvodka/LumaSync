# LumaSync

LumaSync is a tray-first desktop app for screen-synced WS2812B lighting control via USB-connected microcontrollers.

It combines a React + TypeScript frontend with a Rust/Tauri runtime to keep the UI responsive while handling native desktop behavior.

## Why LumaSync

- Tray-first UX for quick control without cluttering the desktop.
- Real-time lighting workflow with calibration and device setup flows.
- Strong contracts between frontend and Tauri commands.
- Test-ready architecture with Vitest (frontend) and Cargo tests (Rust).

## Tech Stack

- Frontend: Vite, React 19, TypeScript (strict), Tailwind CSS
- Desktop runtime: Tauri v2, Rust
- Testing: Vitest + Testing Library, Cargo test
- Package manager: Yarn

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
- `yarn typecheck`: run TypeScript checks
- `yarn lint`: alias for typecheck
- `yarn verify:shell-contracts`: validate shell contract compatibility
- `yarn check:rust`: run Rust `cargo check`
- `yarn check:all`: run JS + Rust + shell contract checks

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

No license file is currently defined in this repository.
If you plan to publish this project as open source, add a license file (for example MIT, Apache-2.0, or GPL-3.0) before accepting external contributions.
