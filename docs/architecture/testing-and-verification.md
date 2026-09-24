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
| WDIO e2e (`e2e/`) | CI, `e2e-macos` job, **not required** | what a real layout engine and a real window decide |

The last row used to read "nobody — by hand only", because `ci.yml` never invoked `wdio` and
`release.yml` only compiled the specs via `typecheck:e2e`. That is fixed by the `e2e-macos` job (see
below), but the caveat only narrows, it does not disappear: the job is not a required status check,
so a red run does not block a merge, and it proves only what a macOS runner shows — Linux and
Windows are still unverified by this layer. **Treat anything this layer asserts on a platform it did
not just run on as unverified until you have run it yourself.**

## The CI e2e job (`e2e-macos`)

`.github/workflows/ci.yml`'s `e2e-macos` job runs the WDIO suite and the UI audit probe on
`macos-latest`, on every PR and every push to `main` — the one OS the `embedded` WebDriver provider
works on at all (`tauri-driver` is Windows+Linux only, see below). It exists specifically so nobody
has to run this layer on a machine they are also using: a GitHub-hosted runner can never be occluded
by other work, and its `shell-state.json` is always a fresh file the job's own run created, never a
maintainer's real one.

It is **deliberately not a required check** — branch protection pins the four `Build and
Check (<os>)` / `Analyze (javascript-typescript)` contexts by name, and this job must never take one
of those names (renaming a workflow job renames its status context; see `ls-project-bugs`, "branch
protection deadlock" post-mortem, for what that did the one time it happened by accident).

Steps, mirroring the `verify` job's macOS toolchain setup (same pinned actions, same Xcode-26
selection, same `rust-toolchain.toml`) but with its own `Swatinem/rust-cache` key
(`macos-latest-e2e`, distinct from `verify`'s `macos-latest`): install the toolchain, `bun run
e2e:build` (builds with `--features e2e`, never `cargo test`, which overwrites the same binary path
with a dev-cfg build that loads the Vite dev URL and comes up blank), run `npx wdio run
wdio.conf.ts`, then run the probe with `LUMASYNC_AUDIT_OUT` pointed at a workspace directory. Both
WDIO runs are teed to a log file; the probe step and the artifact upload both run with `if: always`,
so a failed suite still leaves behind the PNGs, `report.json`, and both WDIO logs. Artifacts land
under the `e2e-macos-artifacts` name (`e2e-artifacts/wdio-logs/*.log`, `e2e-artifacts/audit/*.png`,
`e2e-artifacts/audit/report.json`), retained 14 days.

**No `shell-state.json` seed.** The job runs against whatever the runner starts with — nothing, on a
fresh runner — and this was audited rather than assumed:

- The `verify` job's own launch-smoke step already proves cold boot (zero prior state) works on
  every push, on all three OSes.
- Onboarding is a dismissible hint in the shell's notice slot, never a full-screen gate
  (`useOnboardingStep.ts`: "onboarding is a hint, not a gate") — it cannot block `waitForAppReady`,
  which only waits for the mode strip or a section tab, neither of which onboarding covers.
- Every spec that could be state-sensitive already reads persisted state instead of assuming it:
  `shell.e2e.ts` captures `persistedUiMode()` rather than hard-coding a starting mode (see the
  round-trip bug fixed by that change, further down this file), and `shellLightingMode.e2e.ts`
  drives Ambilight/Solid only when the button's own `disabled` attribute says the app's
  `hasAnyOutput` gate allows it — which it never does on a runner with no serial device, no WLED
  target, and no paired Hue bridge, so those two modes are always skipped there, not force-driven
  against nothing.
- Nothing the specs touch reaches the network in a way that can hang: the e2e build's `e2eBuild`
  launch-context flag makes `useAutoUpdater` skip the startup update check outright; Hue bridge
  discovery is invoked only from the pairing button the specs never click, never on boot or on
  opening the Hue device-category rail; and macOS screen-capture consent has two calls behind two
  different gates (`screen_capture_permission.rs`) — `get_screen_capture_permission` only ever calls
  the non-prompting `CGPreflightScreenCaptureAccess`, and the prompting `CGRequestScreenCaptureAccess`
  is reserved for the capture-start path, which is unreachable here because Ambilight is always
  disabled (no output target) on a bare runner.

If a future spec needs a *completed* onboarding state or a paired device to exercise a path this
audit didn't need, seed a minimal `shell-state.json` in a step before the suite runs (the path is
`~/Library/Application Support/com.lumasync.app/shell-state.json` on macOS, keyed by
`SHELL_STORE_KEY` from `src/shared/contracts/shell.ts`) and say so in that spec's own comment, the
way `shell.e2e.ts` documents why it reads rather than sets the starting UI mode.

## The act() warning ratchet

React logs *"An update to X inside a test was not wrapped in act(...)"* when a component changes
state after the test stopped waiting for it. Each one is an assertion that may have run before the
component settled — a test that can pass against the wrong screen. `vitest.config.ts` appends
`scripts/verify/act-warning-ratchet.mjs` to the default reporters; it counts those warnings across
the run and fails it when the count exceeds `scripts/verify/act-warning-baseline.txt`. So CI's
ordinary `bun run test` step enforces it with no extra run.

The baseline may only go down. A count below it is printed (and annotated on GitHub), not failed:
a partial run always sees fewer, and the step sits inside a required check where a timing-dependent
miss must not turn a PR red. Lower the file by hand when a full run reports fewer. When it was
introduced the count was 122, all from three files — `RoomMapEditor.test.tsx` (50),
`LightsSection.test.tsx` (48) and `DeviceSection.test.tsx` (24) — and stable across worker counts.

Two ways it goes blind: a `--reporter` flag replaces the configured list and drops the ratchet with
it, and a test that stubs `console.error` swallows the warning before any reporter sees it.
Under an AI coding agent, vitest detects the agent and switches to its `minimal` reporter, which
prints no console output at all — the warnings are still counted, just not shown.

## Typed test doubles, and the untyped-mock ratchet

A bare `vi.fn()` is `Mock<Procedure>`, assignable to any function: a double on the Tauri boundary
can resolve a shape the backend never sends and the test still passes. On the command boundary use
`mockCommands({...})` from `src/test/mockCommands.ts` — its fixtures are typed by `CommandMap`, and
a command without a fixture rejects naming itself — or `invokeFromCommands({...})` as the
implementation of a mocked `invoke`. For a mocked bridge function, `vi.fn<typeof api.fn>()`.

Typing the first 279 boundary doubles found fixtures no backend could produce: a
`HUE_CREDENTIAL_OK` that no producer has ever emitted, runtime results without the fields Rust
always sends as `null`, a twin-overlay reply of `{ ok: true }`, a serial status of
`{ connected: true }`. `verify:untyped-mocks` (in `check:all`) counts the bare `vi.fn()` left under
`src/`, `mock/` and `e2e/`, comments excluded, against `scripts/verify/untyped-mock-baseline.txt`.
The count is static, so it is exact: above the baseline fails, and below it fails until the file is
lowered. Callback props (`onChange: vi.fn()`) make up most of what remains.

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

**An open dialog fails the step, and the e2e build never checks for updates on its own.** A failed
startup update check once opened `UpdateModal` over the whole window, and every spec and the audit
probe then navigated behind it and passed: `clickTestId` clicks through JavaScript, which reaches a
control no user could reach under a modal. `waitForAppReady`, `switchUiMode` and `clickTestId` now
call `assertNoOpenDialog`, which fails on any rendered `[role="dialog"]`, `[role="alertdialog"]` or
`[aria-modal="true"]` and quotes its role, name and visible text. The probe records `openDialogs` in
every section's structure and fails once it has captured the PNG. A spec that opens a dialog on
purpose must close it before the next helper call. Separately, `get_launch_context` reports
`e2eBuild` (`cfg!(feature = "e2e")`), and `useAutoUpdater` skips the automatic startup check when it
is set, so a run's first screen does not depend on what the live feed answers that day. A check the
user starts still reaches the feed; the unit tests cover both paths.

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

- **Fixtures are bound to the real command map.** `TypedHandlers` (`handlers/types.ts`) types every
  handler from `CommandMap` in `src/shared/contracts/ipc.ts` — the same table `invokeCommand` and
  the test helper `mockCommands` (`src/test/mockCommands.ts`) use — on both the args it reads and
  the value it returns. `handlers/index.ts` derives its coverage guard from the handler keys, so a
  new Rust command stops the mock compiling rather than answering `undefined` for a week. The
  first version was written from command names instead of DTOs and every shape was wrong in a way
  nothing caught; typing it from the map found four more (health-check and runtime results
  omitting fields Rust sends as `null`, and both notification commands answering shapes
  `notifications.rs` never sends).
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
