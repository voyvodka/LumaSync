# The lighting transaction

How a lighting choice reaches the hardware: the mode, the outputs it runs on, the Hue stream, and
the order they move in. Implementation in `src-tauri/src/commands/lighting_mode/` — `outputs.rs`
(the transaction), `snapshot.rs` (what runs), `tuning.rs` (retunes), `hue_driver.rs` (Hue start and
stop), `config_check.rs` (what a mode must pass before it starts) — and
`commands/hue/hue_config.rs` (the Hue start request from saved state). Contract in
`src/shared/contracts/lightingRuntime.ts`.

## The callers

Every surface that changes lighting sends the same request, and every window renders the same
snapshot (`useLightingRuntime.ts`: seeded by `get_lighting_runtime`, kept by
`lighting://runtime-changed`, older revisions dropped).

| Surface | Sends |
|---|---|
| Main window mode buttons, shortcuts | `apply_outputs` `{ mode: { kind, payload if it has one }, origin: "user" }` |
| Main window Outputs toggles, pairing a strip, the unsupported-port fallback | `apply_outputs` `{ targets, origin: "user" }` |
| A strip unplugged | `apply_outputs` `{ targets, origin: "usbUnplug" }` — the rest, or `[]` when it was the only one |
| Launch | `apply_outputs` `{ origin: "boot" }` — Rust reads the saved mode and outputs itself |
| LED control popup mode strip | `apply_outputs` `{ mode, origin: "popup" }` |
| Tray: the Off / Ambilight / Solid check group | built in Rust (`tray_request`), never through a window; the kind alone, `origin: "tray"` |
| Test patterns (LED Setup, popup tiles) | `apply_outputs` `{ targets, origin: "leaseHue" }` around each run |
| Devices card Stop retrying / Retry stop | `release_hue_output` |
| A drag within the running kind (both windows) | `retune_lighting`, through `retuneCoalescer.ts` |
| A saved setting the mode reads | nothing — Rust re-applies on the save (below) |

The main window's orchestrator (`useLightingModeOrchestrator.ts`) is what is left of the frontend
one: the notices and their timers, and the screen-recording preflight. The bare mode commands it
replaced — `set_lighting_mode`, `stop_lighting`, `get_lighting_mode_status`, `stop_hue_stream` — are
no longer registered; their Rust bodies are what the transaction calls, and the tests of the state
machine under it call them directly. `set_hue_solid_color` is still registered, and its tests grant
it to the test window, but no window is granted it: a window calling it would skip the ordering and
the saving below.

## Why it moved to Rust

The ordering rules that make a mode change safe lived in a React hook: start Hue before the worker
so the worker is handed the stream; stop the worker before the Hue stream, because the sender exits
only once every handle is gone (`hue.md`); give back a stream no running mode feeds, because the
bridge admits one streamer. Each surface that changes lighting had to know them — the popup did not,
and never stopped Hue on Off, never started it for Solid or Ambilight, and never saved its choice.
A queued choice had to be replayed from a closure that still held the pre-transition state (see "A
newer choice supersedes" in `ui-and-shell.md`). And every rule was reachable only through a mock of the backend,
so the tests proved the hook called the mocks in order, not that the hardware saw that order.

In Rust the rules run once, in one place, against the real mode machine, and every surface sends
the same request.

## Decisions

**One command reconciles; the request says what the user wants, not what to do.**
`apply_outputs({ mode?, targets?, origin })` records the request as the *intent* (the mode kind
and the selected targets) the moment it arrives, then waits its turn on the same fair
`transitions` lock the mode commands use. The transaction that gets the turn reads the *current*
intent and the running state, and does what it takes to go from one to the other. It is
level-triggered: it never replays a list of requested edits, so a request that was overtaken
leaves nothing to undo.

**The newest request wins.** Each request takes a ticket on arrival. A transaction whose ticket is
no longer the newest returns `OUTPUTS_SUPERSEDED` — at its turn, or at the next phase boundary if
it was already running — and touches no hardware after that point. The newer one reconciles from
wherever the older one stopped: a queued Off behind a start stops the stream that start had just
opened; an unplug behind a queued start runs that start on what the cable left. A lease operation
(below) takes an id, never the newest ticket, so a test pattern never supersedes a mode change.

**Phases, in the order the hardware needs.**

1. Hue up — only if the intent names Hue and no stream is live. A start that answers
   `TRANSIENT_RETRY_SCHEDULED` is cancelled at once: nothing will use it, and left alone it keeps
   retrying unseen. A live stream on another area than the saved `lastHueAreaId` is *moved*: a
   start on a running stream is a no-op whatever its area, so the old session stops first (its
   lights go back) and the saved area starts after it (`hue_area_moved`, `move_hue`). A stream
   opened elsewhere names no area here and is left where it is.
2. The mode, through the real `apply_mode_change`, on the targets that can run it. A Hue gate
   refusal beside USB runs the mode on USB alone (Hue *left out*, with its reason on the wire as
   `HueLeftOutReason`); a device-gate refusal beside Hue runs on Hue alone — the running mode when
   USB was being added, the new choice when it was a mode — and drops `usb` from the session's
   selection (`droppedTargets`) until a strip connects. A payload and target set the running mode
   already carries is not re-applied.
3. Hue down — after the worker has let go. A stream the running mode does not use is stopped if
   this module opened it, or if the mode that used it has gone. A stream the test lease opened is
   the lease's to stop.

A refused start leaves what was running, unless it drives a target the user just deselected: that
one is stopped rather than left lit. A start that tore the old mode down and then failed is
`OUTPUTS_START_FAILED`; the Hue stream it leaves unfed is given back.

**A refused choice says why.** Every refusal used to reach the main window as a status code it did
not read, so a press that changed nothing changed nothing on screen either:

- A choice that named Hue alone, where Hue did not start, carries `hueNotStarted` with the reason;
  the left-out reason has nothing to ride on, since nothing new runs. The reason is read from the
  start's code and the blocker tokens the start gate appends to its `details`
  (`"; readiness: <code>[, <sentinel>]"`, the wire contract on `CONFIG_NOT_READY_GATE_BLOCKED` in
  `hue.ts`), never from the prose around them (`hue_refusal_reason`): a re-pair (`auth`), no bridge
  or area on record (`config`), the active-streamer sentinel (`inUse` — another app holds the area),
  a readiness that found no usable area (`noLights`), anything else `unreachable`.
- The same reasons name a Hue left out beside USB. `inUse` is not `busy`: `busy` belongs to the
  launch's wait, which adds Hue back once the area frees; after a choice nothing waits, so saying
  "Hue joins once it lets go" would be false.
- A strip-only choice with no strip is refused as before, and the main window now says so (the
  output bucket of the start-failure notice). One that also named Hue runs there and raises
  `usbLeftOut` instead, since "lighting didn't start" would be false.

**Every choice's answer rides the snapshot** (`lastOutcome`: request id, origin, status, outcome).
The tray has no window to read a reply, and the main window never saw the popup's; a tray Ambilight
without screen recording, or a tray Solid with no LED layout, used to end as a log line and nothing
anyone could see. Each `user`, `popup` and `tray` transaction that runs to an end publishes its
answer with its final snapshot; a superseded one publishes none, since the newer one answers, and
no other origin publishes one. Every later publish carries it along unchanged.

- The main window reads its own choices from their replies and every other origin's from
  `lastOutcome`, through the same reader (`readAnswer` in `useLightingModeOrchestrator.ts`), so the
  notice is the one its own button would have raised. Two differences: a remote answer that needs a
  layout never moves the window to LED Setup (the calibration notice already stands on Lights), and
  the first snapshot the window sees is a baseline, not news. Request ids only grow, so an answer is
  raised once however often later snapshots repeat it.
- A tray answer that fell short while the main window is hidden also raises an OS notification
  (`useTrayFailureNotification.ts`), in the notices' own copy (`choiceFailureMessage.ts`). The same
  sentence within a minute is not repeated, and a tray choice that ran clears that memory. A
  visible window's notice is enough; a choice that ran says nothing.
- The popup shows its own refused or failed choice inline, in the same copy.

**The tray's mode group is a check group** (`TrayLighting`, `tray_mode_items`). Off, Ambilight and
Solid are check items; the check follows the snapshot's running mode, redrawn on every publish
(`sync_tray_modes` in `lib.rs`, newest revision wins). A click toggles a check item natively before
the choice has run, so the group is redrawn at once from what runs; clicking the running mode sends
nothing, as its button in the window does nothing. The items are greyed while a transaction runs,
and each one the main window's own mode button has disabled — no layout for a bound strip, no
output, a choice in flight — which the window pushes as `TrayLabels.lockedModes` with the labels.
With no window loaded nothing is locked and the transaction's gates answer instead. The draws are
posted to the main thread rather than waited on: a menu call from another thread blocks until the
main thread runs it, and the quit can hold the main thread while a transaction still publishes.
Solid sends no payload, so it shows the last colour, or `DEFAULT_SOLID` before any was chosen. The
old "Resume last mode" item is gone: it did the same as Solid whenever Solid ran last, and there was
no way back to Ambilight.

**A reconnect that finds another app on the area stops under its own code.** The reconnect monitor
re-reads readiness before each attempt and must not take over a foreign session; when the active
streamer is the only blocker it used to spend the whole retry budget on it and end
`TRANSIENT_RETRY_EXHAUSTED`, which reads as a network fault. It now ends `Failed` at once with
`HUE_AREA_TAKEN_OVER` (`restart_refused` in `reconnect.rs`, `register_area_taken_over` in
`retry.rs`), which the Hue card names.

**Off stops the worker first, whatever its targets, then Hue.** A user's Off also stops Hue when a
bridge is configured but no stream is known here, as the frontend's Off did — that is what cancels
a retry. A target change made while Off stops nothing.

**Off turns the lights off.** Pressing Off — a `user`, `tray` or `popup` request carrying the Off
mode (`reconcile_off`, `user_off`) — ends each output it finds driven with its lights dark, rather
than letting go and leaving them as the last frame or the device's own state had them:

- **The strip** gets one all-black frame once the mode has stopped (`blank_usb_after_off` in
  `transition.rs`), encoded like any Solid frame for its profile, chip, order and length. Stopping
  a mode only stops writing, and a strip holds the last frame it was sent — a Solid colour
  indefinitely. `device-output.md` has the transport detail.
- **A WLED device** gets the black frame and then `POST /json/state {"on":false}`, beside the Hue
  stop rather than before it, so an unanswering device cannot hold the Hue switch-off back.
- **Hue** gets `HueLightsAfterStop::TurnOff`, unless `ShellState.hueOffBehavior` is `restore`. The
  setting is read from the saved state when the Off runs, never from the request or the mode's
  payload, so a change made in any window after the mode started counts. Absent is `turnOff`.
  What Hue does with it is in `hue.md` ("Off turns the lights off").

Every other way output ends puts the lights back or leaves them: Hue taken out of a running mode,
the Devices card's stop (`release_hue_output`), every output deselected, a strip unplugged, the
test lease giving back what it opened, a boot restore that is refused, and the quit — none of them
is pressing Off. A launch whose saved mode is Off has nothing running and writes nothing; so does
an Off with nothing running (Hue still gets its stop, which finds no session and no snapshot).

**The intent follows what ran.** A choice the backend did not run is not retried by the next
transaction: the intent's kind settles back to what runs. A target left out of the running mode
drops from the session's selection, never from what is saved.

**What is saved depends on who asked** (`LightingOrigin`):

| Origin | Targets | Mode |
|---|---|---|
| `user`, `tray`, `popup` | saved on arrival (`lastOutputTargets`) | saved once it runs, with the saved targets |
| `boot` | never | never |
| `usbUnplug` | never — the selection changes for the session | never |
| `leaseHue` | never | never touched |

The mode obligation is level, not edge: a choice overtaken by an unplug is saved by the
transaction that runs it. Writes go through `shell_state::patch_from_rust`, which announces them
on `shell://state-changed` with the writer id `rust`, so every window's cache follows.

**Retunes never wait for a transition.** A brightness or colour drag commits at up to 20 Hz and must
not queue behind a mode change. `retune_lighting` takes neither `transitions` nor the runtime lock:
it has its own first-come-first-served turn, stores the payload, and applies it to what the last
transaction left *accepting* — the running worker's atomics for Ambilight, a solid sink snapshot
for Solid. A transaction closes accepting (under the same turn, so no retune is mid-send) before
its first stop, and re-applies the stored payload when it commits if a retune arrived meanwhile:
a drag during a start lands, and no colour packet reaches the strip once Off has begun — only
Off's own black frame does. Answers:
`RETUNE_APPLIED`, `RETUNE_DEFERRED` (a transaction bringing that kind up will apply it),
`RETUNE_NOT_RUNNING` (stored for the next start). A settled drag is saved 300 ms after the last
retune.

**What runs is one snapshot, never the runtime lock.** `LightingRuntimeSnapshot` carries the
running mode, the driven targets, the session's selection, the phase, the held-out reason, the
boot wait and the last choice's answer. Its revision is bumped under a small mutex and the event is emitted after that mutex is
released, so two publishers can deliver out of order; `listenLightingRuntime` keeps the higher
revision. A transaction publishes when it starts, at each phase, and when it ends; so do the test
pattern's start and stop. Retunes are coalesced to 10 Hz with a trailing publish so the last value
always goes out. `get_lighting_runtime` reads this cell. It is a sync command, so it runs on the
main thread, and the retired mode-status read used to wait on the runtime lock a transition holds
for seconds; that froze the window.

**Quitting.** Step 1 of the quit sets `LightingRuntimeState::closing` before it stops anything.
`apply_mode_change` reads it under the runtime lock and refuses any start
(`LIGHTING_MODE_SHUTTING_DOWN`) before `stop_previous`, and the Hue start reads it once readiness
has answered, before bringing a stream up. The quit never takes `transitions`, so a transaction
blocked on a Hue start cannot hold it up; when that start returns, the transaction sees the flag
and ends `OUTPUTS_SHUTTING_DOWN` without starting a worker.

**The one Hue retry without the user**, ported from the frontend's boot retry: a launch restore the bridge
refused with `CONFIG_NOT_READY_GATE_BLOCKED` probes readiness every 3 s for up to 25 s (a Tokio
task with a cancel token). Busy is decided by readiness, not by the start code. Once the area is
free it resumes a restore that ended Off, or adds Hue back to one running on USB alone — once. Any
mode choice, any target change without Hue, and any Hue release cancels it; a resume survives a
target change that keeps Hue. The wait shows as `bootHueRetry` (resume) or the held-out reason
`busy` (rejoin), and gives up as `gaveUp` / `busyGaveUp`. A choice made after the wait gave up
takes `gaveUp` down too: it used to outlive the choice whenever the wait ended first, which a paused
test clock reproduced by running the whole window out while a transaction awaited blocking work.

**The launch's wait for the bridge.** Autostart runs the restore before Wi-Fi is up. The start gate
refuses (`CONFIG_NOT_READY_GATE_BLOCKED`, readiness `HUE_STREAM_READINESS_FAILED`), the area wait
above probes once, and that probe answers that the bridge is silent. The wait read it as "not busy"
and gave up for good, so a Hue-only setup stayed Off and `[usb, hue]` ran on the strip alone until
the user chose again. A silent bridge is now its own verdict (`HueAreaVerdict::Unreachable`), and
it — or a start that failed outright for a bridge that did not answer — *parks* the same resume or
rejoin plan instead (`park_boot_hue`). Nothing polls for it. The Hue health monitor already probes
the bridge, and its `hue://health` event is heard in Rust (`listen_hue_health`); the first publish
that says the bridge answers — a probe's answer, not a publish while one is in flight, or a live
stream — runs the parked plan once (`note_hue_reachable`), through the same `resume_boot_hue` the
area wait uses. It fires at most once per launch. Anything that cancels the area wait cancels the
park (a choice, a newer launch, the Devices card's stop); so does a save that leaves no Hue pairing
behind, and a quit, which the resume checks before it runs. While the window is hidden the monitor
probes only when asked, so a park may wait until the window next opens. The strip's own resume
(`BootSinkRetry`) leaves Hue to a parked plan as it does to the area wait, so with both outputs late
either one can land first and the other joins it.

**The launch's wait for a strip.** The boot restore runs while auto-reconnect is still scanning
and settling the strip (~2 s after the port opens), so it sees no local output about a quarter of
the time. It keeps `usb` selected and runs without it — a `[usb]` restore ends Off, a `[usb, hue]`
one runs on Hue — and used to stay that way, since the hot-plug reconciler sees `usb` already
selected and does nothing when the strip connects. A restore that left `usb` out for that reason now
waits for one (`wait_for_local_sink`): the first serial connect or WLED bind within 30 s
(`BOOT_SINK_WAIT_WINDOW`, `note_local_sink_connected` from `connect_serial_port` and
`connect_wled_sink`) runs one `BootSinkRetry` transaction that resumes the mode on the strip, or adds
the strip beside the Hue it runs on. Like the boot restore it saves nothing. Any request that says
what should run — a choice, an unplug, a newer launch — ends the wait, and a connect after the
window starts nothing. A strip that connected while the restore was still running is caught when
the wait is set up. When the Hue wait is also pending, the strip resume leaves Hue to it.

The main window no longer awaits the restore: it can wait seconds on a Hue start, and the tray
labels, onboarding and prompts waited with it. Only the USB reconciler and the Hue auto-add
(below) still wait (`lightingRestored`), because they write a selection from the one they read and
the restore is what sets it.

**The Hue test lease**, ported from the frontend's: `origin: "leaseHue"` with targets naming Hue brings
the stream up for a test run and remembers whether it opened it; any other targets hand it back —
only if it opened it, and not if a mode started meanwhile adopted the stream.

**Hue start requests are built in Rust.** `hue_config.rs` reads the bridge, area and pairing
evidence through typed `shell_state.rs` accessors — paired is a legacy key on disk or the keychain
backend, as the frontend decides it — and leaves an empty key for the start path to resolve from
the keychain. The channel placements are a port of `toChannelPlacements`, and the room geometry a
port of `toRoomGeometry`. One JSON fixture
(`src/features/hue/model/__tests__/fixtures/channelPlacements.parity.json`) is read by both the
vitest suite and `cargo test`: change one side without the other and a suite fails.

**Settings refresh.** A window's write to the shell state that names a key the running mode reads
(`selectedDisplayId`, `lightingIntensityPreset`, `colorCorrection`, `firmwareProfile`,
`selectedChipType`, `ledColorOrder`, `roomMap`, `lastHueAreaId`, `ledCalibration`) schedules a
re-apply of what runs, 300 ms after the last such save (`note_settings_saved`, hooked into
`patch_shell_state` and `replace_shell_state`). It replaces a re-dispatch every settings panel made
from the main window, which the popup and every other writer of those keys never did. The refresh
takes the newest ticket as it stands rather than a new one, so it never supersedes a choice in
flight; the save also marks the running payload stale, so a choice that arrives after it re-applies
even when its request names nothing new. It leaves a test pattern alone — the test's own stop
restores the mode from the saved settings — and does nothing while Off.

- `ledCalibration` joined the list because a layout saved while a mode ran never reached it: the
  mode kept the old layout until something else re-applied. LED Setup saves it while a test owns
  the strip, which the refresh already leaves alone, and on steps that change nothing, so a save
  naming only `ledCalibration` is skipped when the running mode already carries that layout or does
  not drive the strip (`calibration_is_current`).
- A saved `lastHueAreaId` that differs from the live stream's area moves the stream (phase 1 above).
  A move the new area refuses leaves Hue out with its reason and keeps the rest running; a Hue-only
  mode with nowhere left to run ends.
- A refresh keeps Hue in a mode that already runs on it while the stream reconnects
  (`hue_gate_waived` on the runtime owner, set for that one apply). The Hue gate used to refuse the
  whole re-apply, so the strip beside a reconnecting stream ignored colour correction, colour order
  and display changes; the worker follows the live slot, so Hue picks the change up when it is back.

**A test pattern is not the mode.** A test runs as an Ambilight worker over a synthetic source, but
starting one publishes nothing: every window keeps showing the mode it interrupted, and the test's
stop publishes the restored one. The main window used to render the test as Ambilight running.

**Targets are a set, and an unknown one is an error.** The request carries target names; they parse
into a `BTreeSet<OutputTarget>` (ordered `usb, hue`, deduped by construction), and a name this build
does not know answers `OUTPUTS_INVALID_REQUEST` with nothing recorded, saved or touched. It used to
be dropped, and a selection that lost its only real output started a capture worker driving
nothing. `apply_mode_change` refuses the same way for a mode that reaches it by another road.

**A config that cannot be trusted is refused before anything is torn down**
(`LIGHTING_MODE_INVALID_CONFIG`, `config_check.rs`): a LED calibration whose edge counts do not add
up to its total, holds more than `MAX_TOTAL_LEDS` (4096 — four `u16` edge counts reach 262 140,
and every frame allocates per LED), has a bottom gap wider than the bottom edge, or carries an
enum string this build does not know; or a colour correction outside the panel's ranges. It is a
gate like the device and Hue gates, so the transaction answers `OUTPUTS_REFUSED` and what ran keeps
running. A refused layout (`details` starting `ledCalibration`) is read by both windows as the
calibration gate: the main window opens LED Setup and the popup says the strip needs calibrating
(`needsCalibration` in `modeApplyOutcome.ts`). The saved colour correction is clamped as the frontend's normaliser clamps it, so a value
an older build let through does not start refusing every mode after an update.

**What stays in the frontend.** The notice copy and its timers, the screen-recording preflight
(it only chooses a notice; the start is what asks), unplug detection, the Hue status read for
the chip (read-only: it no longer forces a re-apply when a stream comes back, since the worker
follows the live slot), and the retune coalescer.

## Testing

`lighting_mode/outputs_tests.rs` drives the real transaction, the real `apply_mode_change` and
the real worker over a still frame, a recording serial sender, a fake Hue driver publishing into a
real `HueOutputLive`, and an in-memory shell state (`test_support.rs`). Each scenario reads one
ordered log of what the hardware saw — strip packets, Hue starts and stops, mode changes — plus
what was published and what was saved. Most scenarios port a case of the orchestrator's vitest
suite and name it. The boot retry runs on a paused Tokio clock. The production Hue driver is out of
reach of a test binary: resolving it panics under `cfg(test)`, and `KeychainStore` refuses every
call there. So does the production WLED switch-off: the rig manages a `WledPowerOffHandle` that
records `wled:off:<ip>` in the log instead.

## Gotchas

- **`get_lighting_runtime` answers from the last publish.** During a transition it reports the
  mode from before it; it never blocks until the transition finishes. A caller that must see the
  outcome reads the transaction's own reply.
- **The driven targets are the truth, not the UI's hopes.** A Hue stream whose stop did not confirm
  stays in `activeTargets`, because the bridge may still count it as its streamer; a stream the
  Devices card opened beside a USB-only mode is not in them, because no mode drives it.
- **Adding a field to the snapshot or the outcome is a wire change**: the contract verifier pairs
  each Rust struct with its interface and pins the count.
