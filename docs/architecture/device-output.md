# USB serial and network output

The output sinks other than Hue: USB LED controllers over serial, and WLED devices over UDP.
Implementation in `src-tauri/src/commands/` — `device_connection.rs`, `led_sink.rs`,
`led_output.rs`, `wled_sink.rs`, `device_handshake.rs`.

## Decisions

**USB serial is gated by a 9-entry VID/PID allowlist.** `SUPPORTED_USB_DEVICE_ALLOWLIST` in
`commands/device_connection.rs`: CH340, FTDI FT232R, CP2102, Arduino Uno R3+, Arduino Uno (early),
PL2303, CH341, CP2104, FT232H. Every port is enumerated and returned with `isSupported` so the user
can see what was found; connecting to anything outside the list is refused with `PORT_UNSUPPORTED`.

The allowlist exists because a serial port is not self-describing — opening an arbitrary one and
writing LED frames at 115200 means writing to whatever the user has plugged in. Showing every port
but refusing to open the unknown ones is the compromise between discoverability and not driving a
stranger's device.

**Read the constant. Never hardcode the list elsewhere.** A second copy is a second thing to keep
in sync, and the failure is silent: a device works in one code path and is rejected in another.

**Serial link is 115200 baud, 8N1.**

**Every sink goes through the `LedSink` trait.** Serial and WLED differ in transport, not in what
they are asked to do. New output types implement the trait rather than branching at the call site.

**WLED is driven over UDP with DDP and WARLS.** These are WLED's own realtime protocols; there is
no HTTP request per frame.

**Opening a port needs a 2 s settle delay before the handshake.** `BOOTLOADER_SETTLE_DELAY_MS` in
`commands/device_connection.rs`. Opening the port asserts DTR, which triggers the AVR auto-reset on
Arduino-style boards; the bootloader owns the bus for ~1.5–2 s before jumping to the sketch, and a
PING sent inside that window is a guaranteed `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`. The delay must run
inside `spawn_blocking` — on the IPC dispatcher thread it froze the whole app for ~4 s during Run
Health Check (observed on v1.5.0-rc). Cost is +2 s per connect and per health check, accepted: the
alternative is a guaranteed handshake failure on every Arduino-class board.

## Gotchas

- **Opening a serial port toggles DTR, which resets many boards.** Reconnecting on every mode change makes an Arduino-class controller reboot each time, so a cached session is deliberately preserved across mode changes — the log line `cached serial session preserved to avoid DTR-reset cycle` is that working as intended, not a leak.
- **macOS phantom serial endpoints accept `open()` and `write()` and go nowhere.** `/dev/cu.Bluetooth-Incoming-Port` and similar route to nothing — every frame "succeeds" at 20 Hz while the strip stays dark, which a user reads as a crash. This is why the allowlist rejects up front instead of trying and failing.
- **macOS exposes every USB adapter under two paths, and only one of them works.** `/dev/cu.*` is the call-out device and is correct; its `/dev/tty.*` sibling is a blocking terminal device that waits on DCD, and CH340/FTDI/CP2102/Arduino boards never assert it — so the `tty.*` port opens successfully and then stalls, producing "Connect and verify: Pass" followed by a handshake timeout. Real incident, 2026-04-26. All `/dev/tty.*` paths are filtered, including `usbmodem*`, because the `cu.*` sibling always exists.
- **A test pattern must use the same output settings as everything else** — chip type, firmware profile, and colour correction. Bypassing them means the test lights nothing, or the wrong colours, on exactly the hardware it exists to verify. This shipped broken once.
- **`lastSuccessfulPort` and `lastWledSink` are mutually exclusive, and the code that writes one clears the other.** `ActiveSinkRegistry` holds one sink per output channel, so a serial connect evicts WLED in Rust and vice versa. If both were persisted, both boot paths would fire: the WLED restore lands first, then the serial auto-reconnect evicts it — the 2 s `BOOTLOADER_SETTLE_DELAY_MS` guarantees serial finishes last. The user would see a "connected" WLED device receiving nothing. Mirroring the eviction in persisted state is what keeps the restore honest; there is no separate "which family is active" flag to drift.
- **A WLED restore probes before it connects, because `connect_wled_sink` cannot fail for an absent device.** `WledUdpSink::start()` binds a local `0.0.0.0:0` socket and never contacts the bridge, so a blind restore reports `WLED_CONNECT_OK` for a device that is powered off. `restoreWledSink` runs `discover_wled_devices` (an HTTP `/json/info` probe) first and only registers the sink once the device has answered. `test_wled_bridge` would prove reachability too, but it sends a red-ramp frame — not something to do to someone's lights at every launch.
- **The room map is currently Hue-only.** `src/shared/contracts/roomMap.ts` models positions and room dimensions, and `commands/room_map/hue_zone.rs` maps zones onto Hue channels — but no serial or WLED sink reads any of it. Placement does not yet affect what a USB strip is sent.
- **`connectionEvents.ts` exists because pairing in one mount used to be invisible to the others.** `useDeviceConnection` is instantiated separately per caller, each with its own connection state; before the pub-sub, a pair completed in `DeviceSection.tsx` left the Lights surface believing USB was still offline until a WebView reload. A single shared instance would have fixed that too, but breaks every per-scenario controller test fixture, which builds a fresh controller per test. The pub-sub is the fix that keeps both: whichever mount observes a pair broadcasts it, and the others re-pull from Rust — but it bridges *state* only, not the *work* each mount does to get there.
- **`useDeviceConnection` is mounted twice, each with its own controller instance:** `App.tsx` (Lights surface, StatusBar pill, `usbConnected` prop) and `DeviceSection.tsx` (the pair UI). Each mount runs its own boot-time port scan and, when a `lastSuccessfulPort` is persisted, its own auto-reconnect attempt — so a cold launch does that work twice concurrently instead of once, and the pub-sub above does not dedupe it. Collapsing the two mounts to a singleton is still a real architecture change beyond the pub-sub fix and remains untaken.
- **`control/FirmwareProfilePicker.tsx` used to be a third full controller mount, solely to read `latestHealthCheck.advertisedFirmwareProfile`.** Fixed: `runHealthCheck` (in `state/healthCheck.ts`) now broadcasts the advertised profile on a dedicated `firmwareProfileEvents` bus, and the picker reads it via the lightweight `useAdvertisedFirmwareProfile` hook — same pattern as `useUsbConnectionStatus`. This also fixed a latent correctness bug: because each controller mount is fully isolated, the picker's own (never-triggered) health check meant `advertised` was always `undefined` in its actual mount site (`LightsSection.tsx`, which never passes the `advertisedFirmwareProfile` prop) — the Bug H4 mismatch UX had never actually fired in production. The new bus receives the broadcast from whichever controller (`DeviceSection.tsx`) ran the real health check.
