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
| `verify:design-tokens` | every PR | every bare `var(--lm-*)` names a token that exists — see below |
| `launch-smoke` / `overlay-smoke` | CI | the debug binary starts; on Windows, the overlay paints and passes clicks through |
| WDIO e2e (`e2e/`) | **nobody — by hand only** | what a real layout engine and a real window decide |

The last row is the one to read twice. `ci.yml` never invokes `wdio` and `release.yml` runs
`typecheck:e2e` alone, which compiles the specs without executing them. The suite runs on a
maintainer machine or not at all — which is how it came to encode an assumption that had been false
for several releases. **Treat anything it asserts as unverified until you have run it yourself.**

## The quietest failure CSS has

A reference to an undefined custom property does not warn, does not fall back to
anything visible, and does not break the layout. The declaration is dropped and the
element renders as if the rule were never written.

The room-map zoom controls shipped styled entirely in `--lm-text-dim`, `--lm-text` and
`--lm-accent`. None of the three exists — the token layer is `--lm-ink-dim`, `--lm-ink`,
`--lm-amber` — so every colour on those buttons resolved to nothing, including
`focus-visible:outline-[color:var(--lm-accent)]`. The buttons still looked plausible, and the one
control group that exists for people who cannot use a wheel gesture had no visible focus ring.
Nothing failed, so nothing was noticed.

`verify:design-tokens` closes that. A typo'd token is the same class of bug as a typo'd i18n key,
and that already had a ratchet. A `var(--lm-x, fallback)` passes deliberately: the fallback is how
an author says "undefined here is intended", which is the right shape for a property set inline at
runtime like `--lm-fill`.

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

A locked screen (or a minimized/occluded window) used to produce a believable-looking hang: the run
would time out on `switchUiMode` with "UI mode did not settle on compact", because the compact/full
switch awaited `requestAnimationFrame` with no bound in two places, and the webview stops firing rAF
while unpainted. #423 fixed the product side of that — every such wait now falls back to a 250 ms
timer ([`ui-and-shell.md`](ui-and-shell.md)), so `useUIMode.ts`'s `transitionLockRef` is always
eventually released, screen locked or not.

That fix moved the remaining race entirely onto this layer. `transitionLockRef` is released only
after the double-paint wait and the fade-in, which can trail the DOM's mode-testid swap (what
`currentUiMode()` reads) by roughly half a second while occluded — the 250 ms frame fallback plus
the fade's own safety timeout. A toggle click landing inside that window is dropped by
design, not queued, which is exactly what turned a *successful* switch to compact into "UI mode did
not settle on full" on the very next call — the previous switch's lock was still draining when the
next click fired. `switchUiMode` now retries the click a few times (`MAX_TOGGLE_ATTEMPTS`,
`e2e/support/shell.ts`), re-checking `currentUiMode() === target` first each time so a click that
did land makes every further attempt a no-op. If the window is still unpaintable
(`document.visibilityState`) after exhausting those retries — a screen locked for the whole retry
window, not a transient dip — `switchUiMode`/`waitForAppReady` say so explicitly instead of
surfacing the bare WDIO timeout. That case is not a spec bug and a spec cannot fix it: unlock the
screen (or bring the window to the front) and re-run.

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
- **The IPC boundary cannot be hooked from a spec at all.** Assigning to
  `window.__TAURI_INTERNALS__.invoke` records zero calls while the backend is demonstrably
  working — proven by switching UI modes, watching `shell-state.json`'s mtime change, and reading
  zero from the hook in the same run. The reason is not timing and not bundling: Tauri defines the
  property with `Object.defineProperty(…, { value })` and no descriptor flags, so it is
  `writable: false, configurable: false`, and so is `__TAURI_INTERNALS__` on `window` itself.
  Measured in the app: `invokeWritable: false`, `assignmentStuck: false`. The assignment silently
  does nothing in sloppy mode and throws under a module. `@tauri-apps/api/core` genuinely does read
  the property at call time — late binding is not the problem, the write is. Do not go looking for a
  bundler explanation. Use the Rust log instead; it carries the command, the URL and the failure
  reason.
- **Only the `main` window exists.** `getWindowHandles()` returns one handle, so the LED twin
  overlay and the control popup are out of reach — which is the surface that has historically caused
  the most trouble.
- **The snapshot is the webview, not the window.** No title bar, no tray, no native menu, no
  position or size on the desktop. The class of bug where the wide window opens taller than the
  screen is invisible here by construction.

## Where to go instead

| To check | Use |
|---|---|
| Hover, focus-within, real pointer behaviour | the dev mock in a browser — below |
| A state that needs hardware you do not have | the dev mock |
| What the backend actually did | the Rust log — `docs/debugging.md`, and the patterns in `AGENTS.md` |
| A second window | a manual run, or the dev mock with `?window=<label>` |
| Window geometry, tray, native chrome | a manual run |

## The dev mock

`bun run dev:mock` serves the frontend to a real browser with every `invoke` answered from
fixtures; `bun run tauri:mock` does the same inside the Tauri window, where anything without a
fixture passes through to Rust. The browser branch is the complete one, and it is what makes hover,
focus-within and real pointer behaviour checkable at all — the cursor there is the OS cursor.

Nothing under `src/` may name `mock/`, which is what makes the ship-safety guarantee structural
rather than a matter of trusting tree-shaking; `verify:mock-not-shipped` asserts it and proves the
build guard by running into it. The reverse direction is fine and deliberate: `mock/` imports
contract types, and `mock/hotplug.ts` imports two runtime singletons on purpose.

Four things about it are not obvious and each cost a cycle:

- **Fixtures are bound to the real response types.** `handlers/responses.ts` ties each command to
  its `*Api.ts` return type and `handlers/index.ts` derives its coverage guard from the handler
  keys, so a new Rust command stops the mock compiling rather than answering `undefined` for a
  week. The first version was written from command names instead of DTOs and every shape was wrong
  in a way nothing caught.
- **Events are a third of the surface and none of them is an `invoke`.** The twin overlay, the
  tray menu, the update bar and the cross-window mode sync are all pushed from Rust.
  `mock/events.ts` drives them, sizing each frame from the live calibration rather than a constant
  so the twin cannot render a believable lie.
- **`shouldMockEvents` from `@tauri-apps/api/mocks` cannot unsubscribe.** `_unlisten` sends
  `{ event, eventId }` (`event.js:42`) while the mock's remover reads `args.id` (`mocks.js:120`),
  so `indexOf(undefined)` never matches and no listener is ever removed. The callback itself *was*
  unregistered, so every later emit logs `[TAURI] Couldn't find callback id …` — at 10 Hz against a
  component that remounts, hundreds a second into the console you are trying to read.
  `mock/eventBridge.ts` replaces it, browser-only, so passthrough still reaches Rust under
  `tauri:mock`.
- **A fixture that reports the world instead of the command lies about state.** `stop_hue_stream`
  answered with whatever fault the world held, so against an unreachable bridge the stop returned
  the retry code, the app read that as a failed stop, kept Hue listed active and showed HUE
  STREAMING beside a "can't reach the bridge" notice. Rust's stop is local: it answers
  `HUE_STREAM_STOPPED` (or `HUE_STOP_TIMEOUT_PARTIAL` when its sender will not exit), never a
  bridge fault, and the runtime then sits Idle until the next start; the world's `hue.stopped` flag
  models that. Before trusting a contradiction seen only in the mock, check what the Rust command returns.

**A world edit is not always visible to the app, and the panel says which is which.** Every control
carries a `[live]` / `[revisit]` / `[reload]` badge. The serial connection is the sharp case:
nothing polls `get_serial_connection_status` after boot — the controller re-reads it only when a
sibling publishes on the process-wide `connectionEvents` bus — so editing `connectedPort` alone
leaves the UI insisting the cable is still in. `mock/hotplug.ts` publishes on the same bus the real
pair path uses, which is what makes unplug, boot-time port rejection and WLED binding reach the app
at all.
