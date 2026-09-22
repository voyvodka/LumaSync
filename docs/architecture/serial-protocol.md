# LumaSync serial protocol

The byte-level contract between the LumaSync host and a USB LED controller. It is the single
source for both sides: the host code in `src-tauri/` and any firmware written against it cite this
file, and neither restates it.

**No LumaSync firmware exists yet.** Section 1 describes what the host ships and sends today;
section 2 is planned for the first firmware release and nothing in it is implemented on either
side. Why the link is 115 200 baud, why the port is allowlisted, and the DTR reset trap are
decisions recorded in [`device-output.md`](device-output.md); this file only states the wire.

File and line citations are against the tree this document was committed with. When one drifts,
the symbol name is the anchor — fix the line, do not delete the citation.

## 1. Shipped — protocol v1

### 1.1 Serial link

| Parameter | Value | Source |
|---|---|---|
| Baud rate | 115 200 | `DEFAULT_CONNECT_BAUD_RATE` `commands/device_connection.rs:17`, `OUTPUT_BAUD_RATE` `commands/led_output.rs:15` |
| Framing | 8 data bits, no parity, 1 stop bit, no flow control | `serialport` builder defaults — `device_connection.rs:511`, `:758`, `led_output.rs:446` |
| Throughput | 11 520 bytes/s (10 bit-times per byte) | `SERIAL_LINK_BYTES_PER_SEC` `commands/led_calibration.rs:280` |
| Settle after open | 2 000 ms before the first byte | `BOOTLOADER_SETTLE_DELAY_MS` `device_connection.rs:37`, applied at `:524`, `:778`, `led_output.rs:458` |

**DTR.** Opening the port asserts DTR, which auto-resets Arduino-class boards. The host therefore
waits the settle delay after *every* open before writing, and keeps the output handle open across
mode changes so that streaming does not reboot the board. A device must assume it can be reset at
any time the host opens the port, and must be ready to parse within 2 s of reset.

**Host timeouts.**

| Operation | Timeout | Source |
|---|---|---|
| Open for connect | 1 500 ms | `DEFAULT_CONNECT_TIMEOUT_MS` `device_connection.rs:18` |
| Handshake per-read poll | 50 ms | `HANDSHAKE_PORT_READ_TIMEOUT_MS` `device_connection.rs:23` |
| Handshake round-trip window | 2 000 ms | `HANDSHAKE_ROUND_TRIP_TIMEOUT` `device_connection.rs:31` |
| Output frame write | 500 ms | `OUTPUT_TIMEOUT_MS` `led_output.rs:16` |

### 1.2 Data frame (host → device)

The default framing, selected by `FirmwareProfile::LumaSyncV1` (`led_output.rs:35`). Encoded by
`encode_led_packet_with_corrections` (`led_output.rs:618`) for 3-byte pixels and
`encode_sk6812_packet` (`led_output.rs:801`) for 4-byte pixels; every write is dispatched through
`encode_packet_for_output` (`led_output.rs:749`).

```text
Offset  Width      Field
0       2          magic         = AA 55
2       1          brightness    u8, 0..255
3       2          led_count     u16 little-endian — LEDs, not bytes
5       N × bpp    pixels        bpp = 3 or 4, see 1.3
5+N×bpp 1          checksum      XOR of every preceding byte, magic included
```

Total `6 + N × bpp` bytes (`LED_FRAME_HEADER_BYTES`, `led_calibration.rs:285`).

- **brightness** is `floor(clamp(b, 0, 1) × 255)` (`led_output.rs:624`). The host does **not**
  scale pixel values by it — applying it is the device's job.
- **led_count** saturates at 65 535 (`led_output.rs:625`). A device should reject any count above
  what it was built for.
- **checksum** covers the whole frame (`led_output.rs:654`, `:844`).

Worked example, one LED, brightness 0.5, colour `(255, 0, 128)` after the default 2.2 gamma
(pinned by `solid_payload_encodes_to_deterministic_packet`, `led_output.rs:1099`):

```text
AA 55 7F 01 00 FF 00 38 46
```

### 1.3 Pixel layouts

`LedChipType` (`led_output.rs:70`) chooses the pixel layout and is independent of the framing;
`bytes_per_pixel` is at `led_output.rs:89`.

| Chip type | bpp | Bytes per pixel, in order |
|---|---|---|
| `ws2812b-grb` (default) | 3 | `R G B` |
| `sk6812-rgbw` | 4 | `R' G' B' W` |

**Pixel bytes are logical R, G, B — never the chip's order.** Despite the `ws2812b-grb` name, the
host sends red first. The device reorders into its strip's colour order, which today is whatever
its build compiled in; there is no host-side colour-order setting yet (one is planned). A strip that
shows red and green swapped is a device build with the wrong order, not a host bug.

**Pixels arrive fully corrected.** The host applies saturation, then Kelvin white balance, then a
gamma lookup table, before packing (`led_output.rs:618`, `:678`, `:801`). A device must
not apply gamma again.

**RGBW** is produced after correction by `extract_rgbw` (`led_output.rs:785`):
`W = min(R, G, B)`, then `R' = R − W`, `G' = G − W`, `B' = B − W`. W itself is not passed through
the gamma table; the device drives it at the white emitter's native temperature. Pinned by
`sk6812_w_channel_bypasses_lut_corrections_are_on_rgb_only` (`led_output.rs:1757`).

**RGBW exists only under LumaSync v1.** Adalight has no four-byte pixel, so Adalight with an SK6812
chip type falls back to the three-byte Adalight frame rather than dropping output
(`encode_packet_for_output`, `led_output.rs:749`).

### 1.4 Adalight frame, for comparison

Opt-in via `FirmwareProfile::Adalight`, encoded by `encode_adalight_packet` (`led_output.rs:678`).
It exists so LumaSync can drive firmware that already speaks Adalight; it is not LumaSync's own
format, and the two are not interchangeable.

```text
Offset  Width   Field
0       3       magic      = 41 64 61   ("Ada")
3       2       count − 1  u16 big-endian
5       1       header_chk = HIGH ^ LOW ^ 0x55   (header only)
6       N × 3   pixels     R G B, corrected as in 1.3
```

| | LumaSync v1 | Adalight |
|---|---|---|
| Magic | `AA 55` | `41 64 61` |
| Count | `N`, little-endian | `N − 1`, big-endian |
| Brightness byte | yes | **none** |
| Checksum | XOR of the whole frame, trailing | `HIGH ^ LOW ^ 0x55`, header only |
| RGBW | yes | no |
| Handshake | PING / PONG | none |

Adalight has no brightness field and the host does not pre-scale pixels under it, so the host
brightness setting does not reach an Adalight device; the firmware's own brightness applies. Pinned
by `adalight_header_is_byte_exact` (`led_output.rs:1121`) and `adalight_has_no_brightness_byte`
(`led_output.rs:1149`).

### 1.5 Handshake

Implemented in `commands/device_handshake.rs`. Both frames share the `AA 55` magic
(`FRAME_MAGIC`, `device_handshake.rs:67`) and a trailing XOR over every preceding byte.

**PING, host → device** (`encode_handshake_ping`, `device_handshake.rs:148`), 5 bytes, always
identical:

```text
AA 55 10 00 EF
      │  │  └ XOR of the four bytes before it
      │  └ payload length = 0
      └ opcode PING (HANDSHAKE_OPCODE_PING, device_handshake.rs:61)
```

**PONG, device → host** (`decode_handshake_pong`, `device_handshake.rs:177`), 7 bytes:

```text
Offset  Width  Field
0       2      magic             = AA 55
2       1      opcode            = 11   (HANDSHAKE_OPCODE_PONG, device_handshake.rs:64)
3       2      firmware_version  u16 little-endian, (major << 8) | minor
5       1      firmware_profile  01 = LumaSync v1, 02 = Adalight  (device_handshake.rs:74, :77)
6       1      checksum          XOR of bytes 0..6
```

Example, firmware 1.4 expecting LumaSync v1 frames: `AA 55 11 04 01 01 EA`. The profile byte states
which data framing the device expects; the host compares it with the user's setting and shows a
mismatch rather than switching on its own.

**When the host sends PING.** Only from the serial health check — on a freshly opened handle,
after the settle delay (`device_connection.rs:758`–`:811`). Connecting does not PING. A device that
does not answer fails the `HANDSHAKE` step non-fatally with `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`, and
the user is told to try the Adalight profile (`device_connection.rs:910`); a malformed reply is
`SERIAL_HEALTH_PROTOCOL_ERROR` (`device_handshake.rs:126`).

**How the host reads the reply.** `perform_handshake` (`device_handshake.rs:297`) reads into a
16-byte buffer until it is full or the 2 s window closes (`:264`, `:308`), then decodes from byte 0.
So the PONG must be the **first** bytes the device sends after the PING — a boot banner or debug
print on the same UART before it is a protocol error — and bytes after the PONG are ignored. A
7-byte PONG does not fill the buffer, so the reported round-trip time currently includes the rest of
the window; do not read it as link latency.

**Telling a PING from a data frame.** Byte 2 is an opcode in a PING and a brightness in a data
frame, and `0x10` is a valid brightness, so the opcode alone cannot decide. A device treats the
five bytes `AA 55 10 00 EF` as a PING. Read as a data frame, those bytes would mean brightness 16
and `led_count = 0xEF00` (61 184 LEDs) — a count no device accepts — so the rule has no false
positive in practice. A data frame of brightness 16 and zero LEDs is `AA 55 10 00 00 EF`: its fifth
byte is `00`, not `EF`.

A device should answer a PING at any time, including between data frames, and resume parsing data
frames afterwards.

### 1.6 Link budget

The host paces frames to what the link can carry. `frame_wire_bytes` (`led_calibration.rs:291`),
`frame_wire_time_ms` (`:300`) and `link_max_fps` (`:309`) compute it from
`SERIAL_LINK_BYTES_PER_SEC`; `SerialSendBudget` (`commands/lighting_mode.rs:1320`) clamps the send
interval to it and flags a strip as link-constrained below 30 fps (`LINK_CONSTRAINED_FPS`,
`lighting_mode.rs:1314`). Only a serial sink gets this budget; WLED does not
(`resolve_quality_config`, `lighting_mode.rs:1420`).

164 LEDs is 498 bytes in RGB — 23 fps — and 662 bytes in RGBW — 17 fps. At the ceiling the link is
continuously busy: there is no idle gap between frames. Pinned by
`a_164_led_strip_is_capped_by_the_link_at_23_fps` (`led_calibration.rs:566`).

## 2. Planned — firmware ≥ 2.0

> **Not yet shipped. No firmware exists.** Nothing in this section is implemented on the host or
> on any device. It is the agreed shape for the first companion firmware release, and details marked
> *proposed* may still change before that release. A 1.x device implements section 1 only and
> remains valid.

Every planned frame uses the handshake shape of 1.5: `AA 55`, opcode, payload length (u8), payload,
XOR of every preceding byte.

### 2.1 Device information — INFO_REQ `0x12` / INFO_RSP `0x13`

The host sends INFO_REQ only after a PONG whose `firmware_version` is `0x0200` or higher. A lower
version gets PING and data frames only.

```text
INFO_REQ  host → device   AA 55 12 00 ED
INFO_RSP  device → host   AA 55 13 <len> <TLV…> <xor>
```

`len` is the byte length of the TLV block. Each TLV is `type u8, length u8, value`. **The host skips
any TLV type it does not know, using its length** — new fields are added as new types, never by
changing an existing one.

| Type | Field | Value |
|---|---|---|
| `0x01` | chip | u8: `1` ws2812b, `2` sk6812-rgbw, `3` apa102, `4` sk9822 |
| `0x02` | compiled colour order | u8 — *proposed*: `0` RGB, `1` RBG, `2` GRB, `3` GBR, `4` BRG, `5` BGR; on RGBW, W is always last |
| `0x03` | led_count | u16 little-endian — LEDs the build drives |
| `0x04` | max_baud | u32 little-endian — highest rate the device accepts through SET_BAUD |
| `0x05` | capabilities | bitfield, *proposed* u32 little-endian: bit 0 RGBW frames, bit 1 hardware brightness, bit 2 SET_BAUD; unknown bits ignored |

What the host does with it: a `chip` that disagrees with the user's chip type, or a `led_count` that
disagrees with the calibration, is surfaced to the user the way a firmware-profile mismatch is —
never corrected silently. The colour order is displayed, and is what the planned host-side
colour-order setting will default to.

### 2.2 Baud negotiation — SET_BAUD `0x14` / ACK `0x15`

Ships in the first firmware release. Offered only when capabilities bit 2 is set, and only to a
rate no higher than `max_baud`.

```text
SET_BAUD  host → device   AA 55 14 04 <baud u32 LE> <xor>
ACK       device → host   AA 55 15 04 <baud u32 LE> <xor>    (proposed: echoes the accepted rate)
```

1. The host sends SET_BAUD while not streaming, at the current rate.
2. The device replies with ACK **at the old rate**, waits for its transmitter to drain, then switches.
3. The host, on the ACK, switches the rate **on the handle it already has** — reopening would assert
   DTR and reset the board — and sends a PING at the new rate within about 500 ms.
4. A PONG at the new rate completes the switch. With no ACK, or no PONG, the host stays at (or
   returns to) 115 200.
5. **Device watchdog:** if no valid PING arrives at the new rate within its window, the device falls
   back to 115 200 on its own. Its window must be longer than the host's 500 ms so a slow host does
   not strand it.

A refused rate gets no ACK. The host treats that as refusal, not as a fault.

Byte 2 of a SET_BAUD is a plausible brightness (20), and its length byte a plausible LED count, so a
data frame can collide with it. *Proposed:* the device honours SET_BAUD only as the first frame after
it has answered an INFO_REQ, and only with a verified checksum and a rate it advertised; anywhere
else the bytes parse as a data frame. INFO_REQ needs no such rule — like PING, its fixed bytes read
as an impossible LED count.

**Host consequence:** the link budget in 1.6 becomes per-connection — `baud / 10` bytes/s for the
negotiated rate — instead of the `SERIAL_LINK_BYTES_PER_SEC` constant. The Adalight profile stays at
115 200 permanently; Adalight has no handshake to negotiate with.

### 2.3 APA102 and SK9822

Supported natively by the same first firmware release. The host protocol does not change for them:

- The host sends ordinary v1 data frames, **3 bytes per pixel**, logical R G B. The link budget is
  the same as WS2812B.
- The device generates the clocked framing itself: a start frame of four `00` bytes; per LED, a
  header byte `0xE0 | level` followed by the three colour bytes in the chip's order; then the end
  frame.
- `level` is the 5-bit global brightness, derived from the v1 brightness byte —
  *proposed* `(brightness × 31 + 127) / 255`. Under the Adalight profile, which has no brightness
  byte, `level` is 31.
- End frame, chip-specific: APA102 needs at least `ceil(N / 16)` extra bytes to clock the data
  through the chain. SK9822 additionally latches on a reset frame, so it gets four `00` bytes before
  those `ceil(N / 16)` bytes. Sending the SK9822 form to both chips is safe.

Until that firmware exists, APA102 and SK9822 go through WLED (section 4).

## 3. Guidance for firmware

- **Separate repository.** Firmware does not live in this repo. It cites this file by its path in
  the LumaSync repository.
- **Permissive licence, written from scratch.** Implement from this specification only. Do not copy,
  port or translate code from Adalight sketches, Hyperion, Prismatik, Boblight or WLED — whatever
  their licence. Protocol shapes are fine to match; implementations are not to be lifted.
- **Resynchronise on the magic.** Parse with a state machine that hunts for `AA 55`. On a bad
  checksum or an out-of-range count, drop the frame and go back to hunting. `AA 55` can occur inside
  pixel data, so a false lock is possible; the count and checksum checks reject it within a frame.
- **Never block on an unknown opcode, and never wait forever for bytes.** Reset the parser to
  hunting if the line goes idle mid-frame for much longer than a byte time (87 µs at 115 200). A
  control frame the build does not implement is not an error to wait on — see 1.5 for how PING is
  recognised and 2.2 for SET_BAUD.
- **Show only verified frames.** Latch pixels to the strip after the checksum passes — never a
  partial or corrupt frame. LEDs past `led_count` keep their last value.
- **Apply brightness; do not apply gamma.** The host sends a brightness byte and gamma-corrected
  pixels (1.2, 1.3).
- **Nothing on the UART but protocol.** No boot banner and no debug output — the host decodes the
  PONG from the first byte it receives (1.5).
- **Mind the LED output while receiving.** At the link ceiling there is no gap between frames
  (1.6). Bit-banged WS2812B output disables interrupts for roughly 30 µs per LED, long enough to
  overrun the UART, so frames arriving during `show()` are corrupted and dropped. Prefer
  microcontrollers that drive the strip by DMA or a peripheral (ESP32 RMT, RP2040 PIO, SAMD DMA);
  on a bit-banging board, expect the effective frame rate to fall below the link ceiling.

## 4. The WLED route

Anything the serial path cannot drive today goes through WLED, which LumaSync already supports as
a sink over UDP — DDP by default, or DRGB/DNRGB (`WledProtocol`, `commands/wled_sink.rs:69`).

- **APA102 and SK9822** — WLED drives clocked strips natively. Wire the strip to a WLED controller
  (ESP32 or ESP8266) and choose the WLED sink in LumaSync.
- **Any strip that needs its own colour order** — WLED has a per-output colour-order setting, so the
  order is set on the device rather than compiled into firmware.

Over WLED the host sends RGB with brightness scaled into the pixel values, because DDP and DRGB have
no brightness field (`CorrectedWledSink`, `wled_sink.rs:227`). The serial link budget does not
apply. WLED is driven over its documented protocols only; no WLED code is used.
