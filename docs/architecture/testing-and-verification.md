# Testing and verification

Where each layer's confidence actually comes from, and — the part that costs people afternoons —
what a green result does **not** cover. Vitest and `cargo test` are ordinary and documented by their
own conventions; this file is about the layer that drives the real window, because that one looks
like it proves more than it does.

## The layers, and what each one is for

| Layer | Runs | Proves |
|---|---|---|
| Vitest | every PR | logic, state machines, contract shapes — fast and hermetic |
| `cargo test` | every PR, three OSes | Rust units, coded-status contracts |
| `verify:shell-contracts` | every PR | every status code crossing IPC is *declared* — a drift guard, not a coverage score |
| `launch-smoke` / `overlay-smoke` | CI | the debug binary starts; on Windows, the overlay paints and passes clicks through |
| WDIO e2e (`e2e/`) | **nobody — by hand only** | what a real layout engine and a real window decide |

The last row is the one to read twice. `ci.yml` never invokes `wdio` and `release.yml` runs
`typecheck:e2e` alone, which compiles the specs without executing them. The suite runs on a
maintainer machine or not at all — which is how it came to encode an assumption that had been false
for several releases. **Treat anything it asserts as unverified until you have run it yourself.**

## Driving the real app

`bun run e2e` builds a debug binary and drives it through the `embedded` WebDriver provider —
`tauri-plugin-wdio-webdriver`, gated behind the `e2e` cargo feature so release bundles never carry
it. The provider is `embedded` because `tauri-driver` is Windows and Linux only
([tauri-apps/tauri#7068](https://github.com/tauri-apps/tauri/issues/7068)); this is why the suite
works on a Mac at all. Do not "fix" it by reaching for `tauri-driver`.

Because the server lives inside the app process, `browser.execute` answers in about 3 ms. The
element protocol does not: 5–22 s per call on macOS, which is why `e2e/support/shell.ts` is built
from `execute` alone and never `$()`. `e2e/specs/latency.probe.ts` reproduces the gap. A spec
written with `$()` will look hung rather than slow.

A run **shares the installed app's state**. It reads and writes the same `shell-state.json`, with no
isolated profile, and it opens a visible window that cycles through modes and tabs. So: say so
before running it on a machine someone is using, put back anything a spec seeds, and never assume a
starting state. `shell.e2e.ts` asserted the app "boots into compact mode" long after boot began
restoring the persisted mode; on a machine last left in full, the first three specs failed — and
then the suite *repaired itself*, because the section-routing spec ends by switching back to
compact, so a second run passed and the failure read as a flake.

## Seeing the screen

`browser.saveScreenshot` works, and it is the reason this layer is worth more than its assertions.
The macOS path is a native `WKWebView.takeSnapshotWithConfiguration` returning PNG, measured at
36–145 ms per frame — cheap enough to capture every screen in one pass. `e2e/specs/ui-audit.probe.ts`
does exactly that: it walks the sections, writes a PNG each, and dumps a structural report
(unnamed controls, selection state carried only in CSS, clipped text, tripped error boundary). It
asserts almost nothing on purpose; the judgement belongs to whoever reads the output.

```
npx wdio run wdio.conf.ts --spec e2e/specs/ui-audit.probe.ts
LUMASYNC_AUDIT_SECTION=devices npx wdio run wdio.conf.ts --spec e2e/specs/ui-audit.probe.ts
```

Probes end in `.probe.ts`, outside the `*.e2e.ts` spec glob, so CI never runs them.

## What this layer cannot see

Each of these returns a clean, empty, entirely believable result. That is what makes them dangerous:
the harness does not fail, it just quietly agrees with you.

- **CSS `:hover` is unreachable.** The plugin's pointer events are synthetic — it builds
  `new MouseEvent(...)` in JS and dispatches it (`platform/executor.rs`), so no OS cursor ever moves
  and `document.querySelectorAll(":hover")` stays empty through both `execute` and the W3C Actions
  endpoint. Hover in this app is Tailwind `hover:` throughout and there is not one `onMouseEnter`,
  so **none** of it is verifiable here. A hover test written against this layer passes without
  testing anything.
- **The IPC boundary is not observable from a spec.** A hook installed on
  `window.__TAURI_INTERNALS__.invoke` after bootstrap records zero calls while the backend is
  demonstrably working — proven by switching UI modes, watching `shell-state.json`'s mtime change,
  and reading zero from the hook in the same run. `@tauri-apps/api/core` reads the property at call
  time in source, but the bundle does not. Use the Rust log instead; it carries the command, the URL
  and the failure reason.
- **Only the `main` window exists.** `getWindowHandles()` returns one handle, so the LED twin
  overlay and the control popup are out of reach — which is the surface that has historically caused
  the most trouble.
- **The snapshot is the webview, not the window.** No title bar, no tray, no native menu, no
  position or size on the desktop. The class of bug where the wide window opens taller than the
  screen is invisible here by construction.

## Where to go instead

| To check | Use |
|---|---|
| Hover, focus-within, real pointer behaviour | not yet solvable — see the note below |
| What the backend actually did | the Rust log — `docs/debugging.md`, and the patterns in `CLAUDE.md` |
| A second window | a manual run |
| Window geometry, tray, native chrome | a manual run |

Hover has no answer today. The path that would give one is the plain browser: `bun run dev` serves
the frontend to Chrome, where the cursor is real — but every `invoke` rejects there, so the app
renders entirely in its failure states. Closing that gap means a development mode that answers IPC
with fixtures, at which point the browser becomes a usable surface for anything that is pure UI.
Until it exists, hover is checked by a human looking at the screen.
