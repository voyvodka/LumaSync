# The lighting transaction

How a lighting choice reaches the hardware: the mode, the outputs it runs on, the Hue stream, and
the order they move in. Implementation in `src-tauri/src/commands/lighting_mode/` — `outputs.rs`
(the transaction), `snapshot.rs` (what runs), `tuning.rs` (retunes), `hue_driver.rs` (Hue start and
stop) — and `commands/hue/hue_config.rs` (the Hue start request from saved state). Contract in
`src/shared/contracts/lightingRuntime.ts`.

**Status: built, not yet called.** The commands are registered, tested, and bound in `modeApi.ts`
and `lightingRuntimeEventsApi.ts`, but nothing in the frontend calls them, and no window is granted
them. The frontend orchestrator (`useLightingModeOrchestrator.ts`, the boot restore in
`useShellBootstrap.ts`, `bootHueRetry.ts`, `hueTestLease.ts`) still does this work through
`set_lighting_mode`, `stop_lighting`, `start_hue_stream` and `stop_hue_stream`. The change that
moves the callers over grants each window the commands its code then calls — the window-grants
verifier fails on a grant no code can reach, so granting them early is not an option. The old
commands stay registered.

## Why it moved to Rust

The ordering rules that make a mode change safe lived in a React hook: start Hue before the worker
so the worker is handed the stream; stop the worker before the Hue stream, because the sender exits
only once every handle is gone (`hue.md`); give back a stream no running mode feeds, because the
bridge admits one streamer. Each surface that changes lighting had to know them — the popup did not,
and never stopped Hue on Off, never started it for Solid or Ambilight, and never saved its choice.
A queued choice had to be replayed from a closure that still held the pre-transition state (see the
replay entry in `ui-and-shell.md`). And every rule was reachable only through a mock of the backend,
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
   retrying unseen.
2. The mode, through the real `apply_mode_change`, on the targets that can run it. A Hue gate
   refusal beside USB runs the mode on USB alone (Hue *left out*, with its reason on the wire as
   `HueLeftOutReason`); a device-gate refusal when USB was being *added* keeps the mode running on
   the rest. A payload and target set the running mode already carries is not re-applied.
3. Hue down — after the worker has let go. A stream the running mode does not use is stopped if
   this module opened it, or if the mode that used it has gone. A stream the test lease opened is
   the lease's to stop.

A refused start leaves what was running, unless it drives a target the user just deselected: that
one is stopped rather than left lit. A start that tore the old mode down and then failed is
`OUTPUTS_START_FAILED`; the Hue stream it leaves unfed is given back.

**Off stops the worker first, whatever its targets, then Hue.** A user's Off also stops Hue when a
bridge is configured but no stream is known here, as the frontend's Off did — that is what cancels
a retry. A target change made while Off stops nothing.

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
a drag during a start lands, and no solid packet reaches the strip once Off has begun. Answers:
`RETUNE_APPLIED`, `RETUNE_DEFERRED` (a transaction bringing that kind up will apply it),
`RETUNE_NOT_RUNNING` (stored for the next start). A settled drag is saved 300 ms after the last
retune.

**What runs is one snapshot, never the runtime lock.** `LightingRuntimeSnapshot` carries the
running mode, the driven targets, the session's selection, the phase, the held-out reason and the
boot wait. Its revision is bumped under a small mutex and the event is emitted after that mutex is
released, so two publishers can deliver out of order; `listenLightingRuntime` keeps the higher
revision. A transaction publishes when it starts, at each phase, and when it ends; the old mode
commands publish too. Retunes are coalesced to 10 Hz with a trailing publish so the last value
always goes out. `get_lighting_runtime` and `get_lighting_mode_status` read this cell. Both are
sync commands, so they run on the main thread, and the status read used to wait on the runtime
lock a transition holds for seconds; that froze the window.

**Quitting.** Step 1 of the quit sets `LightingRuntimeState::closing` before it stops anything.
`apply_mode_change` reads it under the runtime lock and refuses any start
(`LIGHTING_MODE_SHUTTING_DOWN`) before `stop_previous`, and the Hue start reads it once readiness
has answered, before bringing a stream up. The quit never takes `transitions`, so a transaction
blocked on a Hue start cannot hold it up; when that start returns, the transaction sees the flag
and ends `OUTPUTS_SHUTTING_DOWN` without starting a worker.

**The one Hue retry without the user**, from `bootHueRetry.ts`: a launch restore the bridge
refused with `CONFIG_NOT_READY_GATE_BLOCKED` probes readiness every 3 s for up to 25 s (a Tokio
task with a cancel token). Busy is decided by readiness, not by the start code. Once the area is
free it resumes a restore that ended Off, or adds Hue back to one running on USB alone — once. Any
mode choice, any target change without Hue, and any Hue release cancels it; a resume survives a
target change that keeps Hue. The wait shows as `bootHueRetry` (resume) or the held-out reason
`busy` (rejoin), and gives up as `gaveUp` / `busyGaveUp`.

**The Hue test lease**, from `hueTestLease.ts`: `origin: "leaseHue"` with targets naming Hue brings
the stream up for a test run and remembers whether it opened it; any other targets hand it back —
only if it opened it, and not if a mode started meanwhile adopted the stream.

**Hue start requests are built in Rust.** `hue_config.rs` reads the bridge, area and pairing
evidence through typed `shell_state.rs` accessors — paired is a legacy key on disk or the keychain
backend, as the frontend decides it — and leaves an empty key for the start path to resolve from
the keychain. The channel placements are a port of `toChannelPlacements`, and the room geometry a
port of `toRoomGeometry`. One JSON fixture
(`src/features/hue/model/__tests__/fixtures/channelPlacements.parity.json`) is read by both the
vitest suite and `cargo test`: change one side without the other and a suite fails.

**What stays in the frontend.** The notice copy and its timers, the screen-recording preflight
(it only chooses a notice; the start is what asks), unplug detection, and the Hue status poll for
the chip.

## Testing

`lighting_mode/outputs_tests.rs` drives the real transaction, the real `apply_mode_change` and
the real worker over a still frame, a recording serial sender, a fake Hue driver publishing into a
real `HueOutputLive`, and an in-memory shell state (`test_support.rs`). Each scenario reads one
ordered log of what the hardware saw — strip packets, Hue starts and stops, mode changes — plus
what was published and what was saved. Most scenarios port a case of the orchestrator's vitest
suite and name it. The boot retry runs on a paused Tokio clock. The production Hue driver is out of
reach of a test binary: resolving it panics under `cfg(test)`, and `KeychainStore` refuses every
call there.

## Gotchas

- **`get_lighting_mode_status` answers from the last publish.** During a transition it reports the
  mode from before it, where it used to block until the transition finished. A caller that must
  see the outcome reads the transaction's own reply.
- **The driven targets are the truth, not the UI's hopes.** A Hue stream whose stop did not confirm
  stays in `activeTargets`, because the bridge may still count it as its streamer; a stream the
  Devices card opened beside a USB-only mode is not in them, because no mode drives it.
- **Adding a field to the snapshot or the outcome is a wire change**: the contract verifier pairs
  each Rust struct with its interface and pins the count.
