# USB serial and network output

The output sinks other than Hue: USB LED controllers over serial, and WLED devices over UDP.
Implementation in `src-tauri/src/commands/` — `device_connection.rs`, `led_sink.rs`,
`led_output.rs`, `wled_sink.rs`, `device_handshake.rs`.

The serial wire format itself — data frames, pixel layouts, the handshake, and what the planned
firmware adds — is specified in [`serial-protocol.md`](serial-protocol.md). This file holds the
decisions around it.

## Decisions

**USB serial is gated by a 9-entry VID/PID allowlist.** `SUPPORTED_USB_DEVICE_ALLOWLIST` in
`commands/device_connection.rs`: CH340, FTDI FT232R, CP2102, Arduino Uno R3+, Arduino Uno (early),
PL2303, CH341, CP2104, FT232H. Every port is enumerated and returned with `isSupported` so the user
can see what was found; connecting to anything outside the list is refused with `PORT_UNSUPPORTED`.

The allowlist exists because a serial port is not self-describing — opening an arbitrary one and
writing LED frames at 115200 means writing to whatever the user has plugged in. Showing every port
but refusing to open the unknown ones is the compromise between discoverability and not driving a
stranger's device.

**A port name reaches `open()` only through the listing, and output only through a connection.**
`admit_port` (`device_connection.rs`) is the single gate for `connect_serial_port` and
`run_serial_health_check`: it admits a name only when `list_serial_ports` would show it with
`isSupported`, so a name typed, left over in `lastSuccessfulPort`, or sent over IPC directly gets
no further than the picker would. On the output side, `apply_mode_change` builds a serial plan only
from a status that is `connected`; a name alone was never admitted, and opening it would bypass the
allowlist. A registered WLED sink is still the "usb" channel with no serial connection at all. The
enumeration and open behind both connect and the health check sit behind `SerialPortIo`, which hands
back the settled handle for the PING, so the tests drive the gate with a synthetic inventory, see
every attempted open, and script what the device answers.

**Read the constant. Never hardcode the list elsewhere.** A second copy is a second thing to keep
in sync, and the failure is silent: a device works in one code path and is rejected in another.

**Serial link is 115200 baud, 8N1 — and on a long strip that, not the software, is the frame-rate
ceiling.** 11 520 bytes/s against a `6 + N × bpp` frame
([`serial-protocol.md`](serial-protocol.md) §1.2) gives `link_max_fps` in
`led_calibration.rs`: 23 fps at 164 LEDs in GRB, 17 fps in RGBW. The pacer already clamps to it and
telemetry already reports it through `linkConstrained` and `linkMaxFps`. Read that number as "the
link is full", not as a pipeline shortfall — it has been misread as one, and the fixes that follow
from the misreading (splitting the frame across two channels) aim at a bottleneck that is not
there. Taking the write off the capture thread (below) let the app reach that ceiling; nothing
host-side takes it past it.

Raising the ceiling means raising the baud, and that is a contract with firmware that is already
flashed rather than a constant to edit. Every chip on the allowlist supports far more than
115 200 — but the host and the device have to agree, and the Adalight profile is pinned at 115 200
by Adalight's own convention, so it could never move. `a_164_led_strip_is_capped_by_the_link_at_23_fps`
pins the arithmetic so the next person meets the explanation instead of the number alone.

**The serial write never blocks the worker.** Each open port gets a writer thread
(`WriterSession`, `led_output.rs`). `send` copies the packet into a latest-wins slot and returns;
the writer takes the newest packet, writes it, and waits out its wire time plus 2 % before taking
another. Before, the worker wrote and then flushed — `tcdrain`, a wait for every byte to leave —
so each frame cost its ~43 ms of wire time on the capture thread, the quality controller counted
that as frame cost and stretched the interval, and a 164-LED strip got about 15 fps from a link
that carries 23. Pacing in the writer instead of draining keeps the property the flush was buying:
the OS buffer never holds a backlog, so what reaches the strip is never older than one wire time.
Streaming never flushes; only Solid, a one-shot write, uses `send_and_wait`, which drains and
reports that packet's own outcome.

What did not change: a failed write still reaches the worker as the same coded error
(`LED_OUTPUT_WRITE_FAILED`, `LED_OUTPUT_FLUSH_FAILED`), one send later, and removes the session so
the send after reopens the port; the bootloader settle still runs once per newly opened handle, on
the caller. Dropping a session — `disconnect_session`, or a failure — interrupts a pacing wait at
once, closes the port before reporting the writer gone, and waits at most `OUTPUT_TIMEOUT_MS` +
100 ms for a write in progress before detaching the thread. The writer allocates nothing per frame
once its two ping-pong buffers have grown; the allocation guard runs the production writer to prove
it (`capture-and-pipeline.md`).

**Every sink goes through the `LedSink` trait.** Serial and WLED differ in transport, not in what
they are asked to do. New output types implement the trait rather than branching at the call site.

**WLED is driven over UDP with DDP, or DRGB/DNRGB on the realtime port.** These are WLED's own
realtime protocols; there is no HTTP request per frame. WLED is also the documented route for any
strip the serial path cannot drive yet — APA102 and SK9822
([`serial-protocol.md`](serial-protocol.md) §4).

**Serial colour order is a host-side correction, relative to the firmware.** `LedColorOrder`
(`led_output.rs`, persisted as `ledColorOrder`) permutes the three colour bytes after the
correction LUTs. It says how to fix what the firmware already sends, not what order the strip's
datasheet names — so a strip showing red and green swapped wants `grb` regardless of its chip —
because the host cannot see what order a flashed build compiled in, and an absolute value would be
wrong for every build that already reorders. `rgb` is the identity and byte-identical to the output
before the setting existed. On RGBW it moves R'G'B' and leaves W fourth. It is retuned live: the
worker reads it from `AmbilightLiveSettings` next to brightness, and it is deliberately not in the
fast-path equality list that forces a restart, because a restart re-opens screen capture for a
byte shuffle. WLED ignores it — WLED has its own per-output colour order, and applying both would
correct twice.

The lighting transaction stamps the order from `ledColorOrder` when it applies a mode (`rgb` when
unset), and a save of `ledColorOrder` re-applies the running mode, which retunes the order in place
(`lighting-transaction.md`, "Settings refresh"). The stamp is caller-wins for anything that does
send one, unlike chip type and profile, which means nothing may put a `colorOrder` into the persisted
`lightingMode` — `normalizeColorOrder` never invents one for that reason. The
Identify flow (`useColorOrderIdentify.ts`) runs one `channelProbe` per slot and saves the three
answers as read. It applies in a fixed order: save, then stop the probe, then retune. Stopping
restores the prior mode with its stamps re-read from disk, so the save must land first; the retune
must wait for the stop, or it would reach the test rather than the restored mode. It only sends a
stop after a start reported itself active — a stop with no test running restores nothing and turns
the lights off.

**Nothing makes the frame length and the panel's length agree, so the sink says so once.** The
frame is sized by the LED calibration and the panel by its own configuration, and the two are
authored independently — newly easy to get wrong now that a WLED-only setup is reachable without a
strip. Both failure directions are silent: DDP writes what it is given and the panel ignores
anything past its end, so a too-long frame leaves the tail of the strip dark, while a short one
leaves the remainder holding its last colour. `WledUdpSink` compares the two on the first frame of
each session and logs `WLED_LENGTH_MISMATCH`. Once per `start()`, not per frame — at 20 Hz the
per-frame version is 1 200 identical lines a minute, which is the same as not reporting it — and
re-armed on `stop()`, because either side may change between sessions. A panel reporting `0` is
reporting "unknown" and is not treated as a mismatch.

**Opening a port needs a 2 s settle delay before the handshake.** `BOOTLOADER_SETTLE_DELAY_MS` in
`commands/device_connection.rs`. Opening the port asserts DTR, which triggers the AVR auto-reset on
Arduino-style boards; the bootloader owns the bus for ~1.5–2 s before jumping to the sketch, and a
PING sent inside that window is a guaranteed `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`. The delay must run
inside `spawn_blocking` — on the IPC dispatcher thread it froze the whole app for ~4 s during Run
Health Check (observed on v1.5.0-rc). Cost is +2 s per connect and per health check, accepted: the
alternative is a guaranteed handshake failure on every Arduino-class board.

## Gotchas

- **Opening a serial port toggles DTR, which resets many boards.** Reconnecting on every mode change makes an Arduino-class controller reboot each time, so a cached session is deliberately preserved across mode changes — the log line `cached serial session preserved to avoid DTR-reset cycle` is that working as intended, not a leak. That preservation is scoped to the *same* port only: `set_active_port` (`lighting_mode.rs`) releases the previous port's cached session via `output_bridge.disconnect_session` the moment the active port actually changes, so switching away from a port does not hold its OS handle open until the app quits. A future `LedSink`-from-registry unification (see `ActiveSinkRegistry` in `commands/device_connection.rs`) must carry this same release-on-switch rule, not just the DTR-preserving cache.
- **The output path settles too, because connect drops its handle.** `connect_serial_port` opens, waits `BOOTLOADER_SETTLE_DELAY_MS`, PINGs on that same handle (`serial-protocol.md` §1.5), and drops it (`drop(handle)` in `connect_serial_port_blocking`). So the first frame reopens the port through `SerialLedPacketSender`'s factory, which is a *second* DTR assert and a second auto-reset; the session cache above only protects frame 2 onward. Frame 1 is the one the user is watching, so the same settle runs after any newly opened output handle. It is an `after_open` hook rather than a `sleep` inside the factory so tests can assert *when* it fires — once per session, never per frame — without waiting 2 s. Paying it per frame would put the capture-to-output path forty times over budget.
- **macOS phantom serial endpoints accept `open()` and `write()` and go nowhere.** `/dev/cu.Bluetooth-Incoming-Port` and similar route to nothing — every frame "succeeds" at 20 Hz while the strip stays dark, which a user reads as a crash. This is why the allowlist rejects up front instead of trying and failing.
- **A failed connect must not leave its port name in the connection status.** `SerialConnectionStatus.portName` is the port that was opened, and is `null` whenever `connected` is false. The refused name goes in `status.details` (`port="…"`). It used to be echoed back, and that did two kinds of damage. `apply_mode_change` (`lighting_mode.rs`) planned USB output from `port_name` even while `connected` was false, so the next Solid or Ambilight start opened and wrote to a port that had just been refused `PORT_UNSUPPORTED`, which bypassed the allowlist. It also fed `useUsbConnectionStatus`, so the room map showed a refused or unplugged port as ONLINE. `failed_connect_status` in `device_connection.rs` builds every failure status and has no way to set a port name, and `apply_mode_change` now requires `connected` as well, so neither side alone can reopen the hole. The LED test pattern needed the second guard most: with no output available it sends `targets: []`, which the legacy rule reads as "USB required", and a test skips the USB gate — so only the plan stood between a stale name and the worker.
- **macOS exposes every USB adapter under two paths, and only one of them works.** `/dev/cu.*` is the call-out device and is correct; its `/dev/tty.*` sibling is a blocking terminal device that waits on DCD, and CH340/FTDI/CP2102/Arduino boards never assert it — so the `tty.*` port opens successfully and then stalls, producing "Connect and verify: Pass" followed by a handshake timeout. Real incident, 2026-04-26. All `/dev/tty.*` paths are filtered, including `usbmodem*`, because the `cu.*` sibling always exists. The filter used to cover only the listing: connect looked names up in the raw inventory, where the `tty.*` sibling carries the same allowlisted VID:PID, so a stale or directly invoked name still opened it. Connect and the health check now refuse an enumerated `tty.*` path with `PORT_UNSUPPORTED` and name the `cu.*` path in `details`, rather than silently opening the sibling — the caller asked for a path, and quietly substituting another would hide the stale value instead of surfacing it. The filter stays macOS-only; no other platform names a serial device `/dev/tty.<name>`.
- **A test pattern must use the same output settings as everything else** — chip type, firmware profile, colour correction, and colour order. Bypassing them means the test lights nothing, or the wrong colours, on exactly the hardware it exists to verify. This shipped broken once.
  **One exception: `channelProbe` pins the identity colour order.** It lights a single wire slot pure red, green or blue so the user can report which colour that slot shows, and the answer is only meaningful when nothing reorders the slots — under a saved order the probe would confirm the saved order instead of measuring the firmware. Only the order is overridden (set on the test config, and hydration is caller-wins); chip type, profile and correction still apply. A slot above 2 is refused with `LED_TEST_PATTERN_INVALID_PARAMS`.
- **Every serial encoder corrects pixels through one `EncoderPlan`** (`led_output.rs`), built from the colour correction when a `SerialSink` is constructed and once per Solid write — never per frame, because a gamma other than 2.2 costs 768 `powf`s to tabulate. A colour correction change restarts the worker, so a running sink never needs to rebuild it. The colour order is the one field patched in place (`SerialSink::set_color_order`), which touches nothing else in the plan. Before the plan existed each encoder derived its own corrections, and the default one (LumaSync v1 + WS2812B) quietly hardcoded gamma 2.2, so the gamma sliders did nothing on the most common setup. A new per-pixel stage belongs in the plan, not in one encoder.
- **Adalight carries no brightness, so the host scales the pixels.** Third-party Adalight firmware has no brightness input, so the Adalight encoder multiplies the corrected pixels by brightness, the same way `CorrectedWledSink` does. Only LumaSync v1 frames carry a brightness byte. The slider used to do nothing under Adalight.
- **The frame budget sizes pixels by what the encoder actually writes, not by the chip type.** `WirePixelLayout::for_output` decides both the encoder dispatch and the 115 200-baud budget. SK6812 under Adalight is sent as 3-byte pixels, because Adalight has no RGBW frame, and sizing it at 4 bytes held it a quarter below the frame rate the link can carry.
- **`lastSuccessfulPort` and `lastWledSink` are mutually exclusive, and the code that writes one clears the other.** `ActiveSinkRegistry` holds one sink per output channel, so a serial connect evicts WLED in Rust and vice versa. If both were persisted, both boot paths would fire: the WLED restore lands first, then the serial auto-reconnect evicts it — the 2 s `BOOTLOADER_SETTLE_DELAY_MS` guarantees serial finishes last. The user would see a "connected" WLED device receiving nothing. Mirroring the eviction in persisted state is what keeps the restore honest; there is no separate "which family is active" flag to drift.
- **A WLED restore probes before it connects, because `connect_wled_sink` cannot fail for an absent device.** `WledUdpSink::start()` binds a local `0.0.0.0:0` socket and never contacts the bridge, so a blind restore reports `WLED_CONNECT_OK` for a device that is powered off. `restoreWledSink` runs `discover_wled_devices` (an HTTP `/json/info` probe) first and only registers the sink once the device has answered. `test_wled_bridge` would prove reachability too, but it sends a red-ramp frame — not something to do to someone's lights at every launch.
- **The room map is currently Hue-only.** `src/shared/contracts/roomMap.ts` models positions and room dimensions, and `commands/room_map/hue_zone.rs` maps zones onto Hue channels — but no serial or WLED sink reads any of it. Placement does not yet affect what a USB strip is sent.
- **`connectionEvents.ts` exists because pairing in one mount used to be invisible to the others.** `useDeviceConnection` is instantiated separately per caller, each with its own connection state; before the pub-sub, a pair completed in `DeviceSection.tsx` left the Lights surface believing USB was still offline until a WebView reload. A single shared instance would have fixed that too, but breaks every per-scenario controller test fixture, which builds a fresh controller per test. The pub-sub is the fix that keeps both: whichever mount observes a pair broadcasts it, and the others re-pull from Rust — but it bridges *state* only, not the *work* each mount does to get there.
- **`useDeviceConnection` is mounted twice, each with its own controller instance:** `App.tsx` (Lights surface, StatusBar pill, `usbConnected` prop) and `DeviceSection.tsx` (the pair UI). Each mount runs its own boot-time port scan and, when a `lastSuccessfulPort` is persisted, its own auto-reconnect attempt — so a cold launch does that work twice concurrently instead of once, and the pub-sub above does not dedupe it. Collapsing the two mounts to a singleton is still a real architecture change beyond the pub-sub fix and remains untaken.
- **`control/FirmwareProfilePicker.tsx` used to be a third full controller mount, solely to read `latestHealthCheck.advertisedFirmwareProfile`.** Fixed: `runHealthCheck` (in `state/healthCheck.ts`) now broadcasts the advertised profile on a dedicated `firmwareProfileEvents` bus, and the picker reads it via the lightweight `useAdvertisedFirmwareProfile` hook — same pattern as `useUsbConnectionStatus`. This also fixed a latent correctness bug: because each controller mount is fully isolated, the picker's own (never-triggered) health check meant `advertised` was always `undefined` in its actual mount site (`LightsSection.tsx`, which never passes the `advertisedFirmwareProfile` prop) — the Bug H4 mismatch UX had never actually fired in production. The new bus receives the broadcast from whichever controller (`DeviceSection.tsx`) ran the real health check.
