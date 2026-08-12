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

## Gotchas

- **Opening a serial port toggles DTR, which resets many boards.** Reconnecting on every mode change makes an Arduino-class controller reboot each time, so a cached session is deliberately preserved across mode changes — the log line `cached serial session preserved to avoid DTR-reset cycle` is that working as intended, not a leak.
- **A test pattern must use the same output settings as everything else** — chip type, firmware profile, and colour correction. Bypassing them means the test lights nothing, or the wrong colours, on exactly the hardware it exists to verify. This shipped broken once.
- **The room map is currently Hue-only.** `src/shared/contracts/roomMap.ts` models positions and room dimensions, and `commands/room_map/hue_zone.rs` maps zones onto Hue channels — but no serial or WLED sink reads any of it. Placement does not yet affect what a USB strip is sent.
