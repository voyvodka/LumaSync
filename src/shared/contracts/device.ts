/**
 * Device connection contracts for frontend <-> backend command bridge.
 */

import type { CommandStatusOf } from "./status";

export const DEVICE_COMMANDS = {
  LIST_PORTS: "list_serial_ports",
  CONNECT_PORT: "connect_serial_port",
  GET_CONNECTION_STATUS: "get_serial_connection_status",
  RUN_HEALTH_CHECK: "run_serial_health_check",
  SET_LIGHTING_MODE: "set_lighting_mode",
  STOP_LIGHTING: "stop_lighting",
  GET_LIGHTING_MODE_STATUS: "get_lighting_mode_status",
  GET_RUNTIME_TELEMETRY: "get_runtime_telemetry",
  /**
   * Probe a single user-supplied IP's `/json/info` endpoint.
   * Manual-IP only; not a LAN scan. Returns `WledDeviceInfo[]` (0 or 1).
   */
  DISCOVER_WLED_DEVICES: "discover_wled_devices",
  /**
   * Promote a discovered WLED instance to the active sink.
   * Mirrors `connect_serial_port` semantics: idempotent, replaces the
   * current sink, no implicit stream start.
   */
  CONNECT_WLED_SINK: "connect_wled_sink",
  /** Probe `/json/info`, cross-check LED count + realtime port, send one test
   * frame, then re-read `info.live` to decide confirmed vs unconfirmed.
   * "Round trip" is historical — UDP has no ACK. See {@link WledTestResponse}. */
  TEST_WLED_BRIDGE: "test_wled_bridge",
  /** Registry snapshot of the bound WLED sink. `lastWledSink` is intent; this is what Rust holds — they diverge when a boot restore fails or serial evicts WLED. */
  GET_WLED_SINK_STATUS: "get_wled_sink_status",
} as const;

export const DEVICE_STATUS = {
  IDLE: "idle",
  SCANNING: "scanning",
  READY: "ready",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  RECONNECTING: "reconnecting",
  HEALTH_CHECKING: "health_checking",
  MANUAL_REQUIRED: "manual_required",
  ERROR: "error",
} as const;

export type DeviceStatus = (typeof DEVICE_STATUS)[keyof typeof DEVICE_STATUS];

/** VID:PID pairs of the supported USB-serial controller chips (allowlist). */
export const SUPPORTED_CONTROLLER_IDS = [
  "1A86:7523", // CH340
  "0403:6001", // FTDI FT232
  "10C4:EA60", // CP2102 (Silicon Labs)
  "2341:0043", // Arduino Uno R3
  "2341:0001", // Arduino Uno (original USB ID)
  "067B:2303", // PL2303 (Prolific)
  "1A86:5523", // CH341 (WinChipHead)
  "10C4:EA70", // CP2104 (Silicon Labs)
  "0403:6014", // FT232H (FTDI Hi-Speed)
] as const;

export type SupportedControllerId = (typeof SUPPORTED_CONTROLLER_IDS)[number];

export const DEVICE_ERROR_CODES = {
  PORT_NOT_FOUND: "PORT_NOT_FOUND",
  /** Port is outside `SUPPORTED_USB_DEVICE_ALLOWLIST`. Was long declared here
   * transposed as `UNSUPPORTED_PORT`, a spelling no producer ever emitted. */
  PORT_UNSUPPORTED: "PORT_UNSUPPORTED",
  /** Frontend fallback minted by `mapModeApiError` — the one member with a TS producer. */
  UNKNOWN: "UNKNOWN",
} as const;

export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[keyof typeof DEVICE_ERROR_CODES];

/** `list_serial_ports` outcome. Separate from {@link DEVICE_ERROR_CODES} because
 * the success arm is not an error and the pair must stay complete. */
export const SERIAL_PORT_LIST_STATUS = {
  OK: "LIST_PORTS_OK",
  FAILED: "LIST_PORTS_FAILED",
} as const;

export type SerialPortListStatusCode =
  (typeof SERIAL_PORT_LIST_STATUS)[keyof typeof SERIAL_PORT_LIST_STATUS];

/** Serial port open outcome, shared by `connect_serial_port` and the
 * `CONNECT_AND_VERIFY` health step. `FAILED` is the catch-all — Rust's
 * `connect_error_code` narrows to the others first, plus `PORT_NOT_FOUND`
 * from {@link DEVICE_ERROR_CODES}. All land on one `status.code`. */
export const SERIAL_CONNECT_STATUS = {
  OK: "CONNECT_OK",
  FAILED: "CONNECT_FAILED",
  /** No connect has been attempted yet — the value `SerialConnectionStatus`
   * carries from first launch until the first `connect_serial_port`. */
  IDLE: "NOT_CONNECTED",
  INVALID_INPUT: "CONNECT_INVALID_INPUT",
  /** Typically a udev/dialout permission gap on Linux, not a user denial. */
  PERMISSION_DENIED: "CONNECT_PERMISSION_DENIED",
  TIMEOUT: "CONNECT_TIMEOUT",
  IO_ERROR: "CONNECT_IO_ERROR",
} as const;

export type SerialConnectStatusCode =
  (typeof SERIAL_CONNECT_STATUS)[keyof typeof SERIAL_CONNECT_STATUS];

/** Thrown by `get_serial_connection_status` as `Err(String)`, formatted
 * `"CODE: detail"`. A `catch` sees these; a `switch (status.code)` never will. */
export const SERIAL_COMMAND_ERRORS = {
  STATUS_READ_FAILED: "STATUS_READ_FAILED",
} as const;

export type SerialCommandErrorCode =
  (typeof SERIAL_COMMAND_ERRORS)[keyof typeof SERIAL_COMMAND_ERRORS];

/** Exactly what `device_connection.rs` puts on `SerialPortListResponse.status`
 * and `SerialConnectionStatus.status`. `UNKNOWN` is out — it is minted by
 * `mapModeApiError` and never crosses this wire. */
export type SerialCommandStatusCode =
  | SerialPortListStatusCode
  | SerialConnectStatusCode
  | typeof DEVICE_ERROR_CODES.PORT_NOT_FOUND
  | typeof DEVICE_ERROR_CODES.PORT_UNSUPPORTED;

export type SerialCommandStatus = CommandStatusOf<SerialCommandStatusCode>;

/** In-flight device operation kind, used to gate concurrent UI actions. */
export const DEVICE_OPERATION = {
  IDLE: "idle",
  RECOVERY: "recovery",
  MANUAL_CONNECT: "manual_connect",
  HEALTH_CHECK: "health_check",
} as const;

export type DeviceOperation = (typeof DEVICE_OPERATION)[keyof typeof DEVICE_OPERATION];

/** Ordered stages of the serial health-check flow. `HANDSHAKE` has no
 * underscore, so the verifier's code harvest cannot see it — the pinned
 * `step:` harvest is the only thing keeping it declared. */
export const DEVICE_HEALTH_STEPS = {
  PORT_VISIBLE: "PORT_VISIBLE",
  PORT_SUPPORTED: "PORT_SUPPORTED",
  CONNECT_AND_VERIFY: "CONNECT_AND_VERIFY",
  HANDSHAKE: "HANDSHAKE",
  /** Not a stage: the sole step reported when the blocking worker panics. */
  HEALTH_CHECK_WORKER: "HEALTH_CHECK_WORKER",
} as const;

export type DeviceHealthStep = (typeof DEVICE_HEALTH_STEPS)[keyof typeof DEVICE_HEALTH_STEPS];

/** Persisted shellStore keys owned by the device feature. */
export const DEVICE_STORE_KEYS = {
  LAST_SUCCESSFUL_PORT: "lastSuccessfulPort",
} as const;

// ---------------------------------------------------------------------------
// Firmware profile (Adalight encoder toggle)
// ---------------------------------------------------------------------------

/**
 * Firmware profile selector for the USB `LedSink`.
 *
 * - `adalight`: widely used "Ada" magic-byte stream, compatible with Prismatik,
 *   Hyperion, Boblight, and most DIY Arduino firmware sketches. This is the
 *   interoperability fallback for users who cannot flash our own firmware.
 * - `lumasync-v1`: LumaSync's native protocol (handshake + framed payload)
 *   that unlocks health-check round-trip metrics and per-frame telemetry.
 *
 * Stored under `ShellState.firmwareProfile`. Absent ⇒ treat as
 * `LUMASYNC_V1` when the handshake succeeds; fall back to `ADALIGHT`
 * when the handshake fails so plain Adalight sketches still light up.
 */
export const FIRMWARE_PROFILE = {
  ADALIGHT: "adalight",
  LUMASYNC_V1: "lumasync-v1",
} as const;

export type FirmwareProfile = (typeof FIRMWARE_PROFILE)[keyof typeof FIRMWARE_PROFILE];

// ---------------------------------------------------------------------------
// LED chip type (SK6812 RGBW host-side encoder)
// ---------------------------------------------------------------------------

/**
 * LED chip type — controls the per-pixel byte layout in the encoded payload.
 *
 * This is an orthogonal axis to `FirmwareProfile`: the profile selects the
 * wire framing family (LumaSync v1 vs Adalight); the chip type selects the
 * per-pixel byte width within the payload.
 *
 * - `ws2812b-grb`: 3-byte RGB pixels (default). Backward-compatible with all
 *   v1.x firmware.
 * - `sk6812-rgbw`: 4-byte RGBW pixels. White channel `W = min(R, G, B)` is
 *   extracted on the host after colour corrections are applied to R/G/B; the
 *   W channel bypasses the LUT so that the firmware's native white
 *   temperature is preserved.
 *
 * APA102 is deferred to v2.0 (firmware companion repo decision pending).
 *
 * Stored under `ShellState.selectedChipType`. Absent ⇒ `WS2812B_GRB`.
 */
export const LED_CHIP_TYPE = {
  WS2812B_GRB: "ws2812b-grb",
  SK6812_RGBW: "sk6812-rgbw",
} as const;

export type LedChipType = (typeof LED_CHIP_TYPE)[keyof typeof LED_CHIP_TYPE];

// ---------------------------------------------------------------------------
// Firmware advertisement — what a LumaSync firmware says about itself in PONG
// ---------------------------------------------------------------------------

/**
 * Pixel layout a LumaSync firmware expects, from the high nibble of PONG
 * byte 5 (`docs/architecture/serial-protocol.md` §1.5). Firmware that predates
 * the nibble sends `0`, which reads as `rgb`. Mirrors Rust `WirePixelLayout`.
 */
export const FIRMWARE_PIXEL_LAYOUT = {
  RGB: "rgb",
  RGBW: "rgbw",
} as const;

export type FirmwarePixelLayout = (typeof FIRMWARE_PIXEL_LAYOUT)[keyof typeof FIRMWARE_PIXEL_LAYOUT];

/** The layout a chip type puts in each pixel — what the firmware must expect. */
export function pixelLayoutForChipType(chipType: LedChipType): FirmwarePixelLayout {
  return chipType === LED_CHIP_TYPE.SK6812_RGBW ? FIRMWARE_PIXEL_LAYOUT.RGBW : FIRMWARE_PIXEL_LAYOUT.RGB;
}

/**
 * A PONG the host accepted. Carried by `SerialConnectionStatus.firmware` and
 * `HealthCheckResult.firmware`; absent there means the device did not answer
 * (Adalight or pre-handshake firmware) or answered garbage — unknown, never
 * "wrong". Advisory only: the host never switches profile or chip type from it.
 */
export interface SerialFirmwareInfo {
  /** `"major.minor"`, e.g. `"1.4"`. */
  version: string;
  /** Raw `(major << 8) | minor` from the PONG. */
  versionRaw: number;
  /** Framing the firmware expects (low nibble of PONG byte 5). */
  profile: FirmwareProfile;
  /** Pixel layout the firmware expects (high nibble of PONG byte 5). */
  pixelLayout: FirmwarePixelLayout;
}

// ---------------------------------------------------------------------------
// LED colour order — host-side correction for the serial sink
// ---------------------------------------------------------------------------

/**
 * Host-side colour-order correction for the USB serial sink.
 *
 * RELATIVE, not absolute: the value corrects whatever order the firmware
 * already reorders into, it does not name the strip's datasheet order. Wire
 * slot `i` carries logical channel `order[i]` after colour correction, so
 * `"grb"` sends G, R, B. `"rgb"` is the identity and is byte-identical to the
 * output before this setting existed. On `sk6812-rgbw` only R'G'B' are
 * permuted; W stays in the fourth slot. WLED ignores it — WLED sets its colour
 * order on the device.
 *
 * Mirrors Rust `LedColorOrder` (`led_output.rs`); `verify:shell-contracts`
 * checks the values. Stored under `ShellState.ledColorOrder`; absent ⇒ `"rgb"`.
 */
export const LED_COLOR_ORDER = {
  RGB: "rgb",
  RBG: "rbg",
  GRB: "grb",
  GBR: "gbr",
  BRG: "brg",
  BGR: "bgr",
} as const;

export type LedColorOrder = (typeof LED_COLOR_ORDER)[keyof typeof LED_COLOR_ORDER];

/** The identity order — what the output was before the setting existed. */
export const DEFAULT_LED_COLOR_ORDER: LedColorOrder = LED_COLOR_ORDER.RGB;

// ---------------------------------------------------------------------------
// Color correction (per-channel gamma, Kelvin, saturation)
// ---------------------------------------------------------------------------

/**
 * Per-channel color correction applied to the LED pixel buffer before
 * hand-off to a `LedSink`. Identical shape is used for both USB and Hue
 * surfaces so a single UI surface edits one persisted struct.
 *
 * Fields live under `ShellState.colorCorrection`. Absent ⇒
 * `DEFAULT_COLOR_CORRECTION` (identity-ish correction for a 6500K white
 * point and no saturation bump).
 */
export interface ColorCorrectionConfig {
  /** Gamma curve exponent for the red channel. */
  gammaR: number;
  /** Gamma curve exponent for the green channel. */
  gammaG: number;
  /** Gamma curve exponent for the blue channel. */
  gammaB: number;
  /**
   * White-point temperature in Kelvin. Lower = warmer, higher = cooler.
   * Applied as a per-channel multiplier on top of gamma.
   */
  kelvin: number;
  /**
   * Saturation multiplier. `1.0` leaves colors untouched, `0.0` produces
   * grayscale, `>1.0` boosts chroma (clipped per-channel at the sink).
   */
  saturation: number;
}

/** Inclusive min/max for each gamma channel. Outside this range firmware clipping is unpredictable. */
export const GAMMA_RANGE = { min: 1.0, max: 3.0 } as const;

/**
 * Inclusive min/max for the Kelvin white-point slider. 2000K ≈ candlelight,
 * 8000K ≈ overcast daylight; the bridge + most panels behave well in this band.
 */
export const KELVIN_RANGE_K = { min: 2000, max: 8000 } as const;

/** Inclusive min/max for saturation. */
export const SATURATION_RANGE = { min: 0.0, max: 2.0 } as const;

/** Identity-ish baseline used when the user has never opened the correction panel. */
export const DEFAULT_COLOR_CORRECTION: ColorCorrectionConfig = {
  gammaR: 2.2,
  gammaG: 2.2,
  gammaB: 2.2,
  kelvin: 6500,
  saturation: 1.0,
};

// ---------------------------------------------------------------------------
// Serial health check report (real handshake round-trip)
// ---------------------------------------------------------------------------

/**
 * Machine-readable status code returned by `run_serial_health_check`.
 *
 * These codes discriminate handshake outcomes so the UI can surface a
 * localized explanation + action hint without parsing a human string:
 *
 * - `SERIAL_HEALTH_OK` — handshake completed; `firmwareVersion` +
 *   `roundTripMs` are populated.
 * - `SERIAL_HEALTH_HANDSHAKE_TIMEOUT` — no reply within the handshake
 *   window; usually a wrong baud rate or a port that is not a LumaSync
 *   controller at all.
 * - `SERIAL_HEALTH_VERSION_MISMATCH` — a warning, not a failure: the
 *   HANDSHAKE step passes with this code when the PONG's version is outside
 *   the host's window (`MIN_FW_VERSION`..`MAX_FW_MAJOR`, `device_handshake.rs`).
 *   The host keeps streaming v1 frames.
 * - `SERIAL_HEALTH_FIRMWARE_MISMATCH` — handshake replied, but the
 *   firmware profile advertised by the device does not match the
 *   user-selected `FirmwareProfile` (distinct from `UNSUPPORTED_PORT`).
 *   No producer: Rust never sees the selected profile, so the pickers compare
 *   `SerialFirmwareInfo` against the setting themselves.
 * - `SERIAL_HEALTH_PROTOCOL_ERROR` — handshake parser failed mid-frame
 *   (checksum, malformed length, unexpected byte). Usually a cable or
 *   interference issue.
 */
export const SERIAL_HEALTH_CODES = {
  OK: "SERIAL_HEALTH_OK",
  HANDSHAKE_TIMEOUT: "SERIAL_HEALTH_HANDSHAKE_TIMEOUT",
  VERSION_MISMATCH: "SERIAL_HEALTH_VERSION_MISMATCH",
  FIRMWARE_MISMATCH: "SERIAL_HEALTH_FIRMWARE_MISMATCH",
  PROTOCOL_ERROR: "SERIAL_HEALTH_PROTOCOL_ERROR",
  /** `spawn_blocking` join failure — reported on the `HEALTH_CHECK_WORKER`
   * step, which replaces the whole step list rather than joining it. */
  WORKER_PANIC: "SERIAL_HEALTH_WORKER_PANIC",
} as const;

export type SerialHealthCode = (typeof SERIAL_HEALTH_CODES)[keyof typeof SERIAL_HEALTH_CODES];

/** Exactly what `run_serial_health_check` puts on `HealthStepResult.code`.
 * `DeviceHealthStep` is in it because a passing step reports its own name as
 * its code — `PORT_VISIBLE` passes with code `PORT_VISIBLE`. */
export type SerialHealthStepWireCode =
  | SerialHealthCode
  | SerialConnectStatusCode
  | SerialPortListStatusCode
  | DeviceErrorCode
  | DeviceHealthStep;

/** Frontend-synthesised: the health-check bridge was never injected, so no
 * command ran. Out of the wire union for the {@link OVERLAY_NO_DISPLAY} reason. */
export const HEALTH_CHECK_NOT_AVAILABLE = "HEALTH_CHECK_NOT_AVAILABLE" as const;

export type SerialHealthStepCode =
  | SerialHealthStepWireCode
  | typeof HEALTH_CHECK_NOT_AVAILABLE;

// ---------------------------------------------------------------------------
// Serial command wire shapes — mirrors of `device_connection.rs`
// ---------------------------------------------------------------------------

/** USB identity of a serial port, when the OS reports one. */
export interface UsbPortMetadata {
  vid: number;
  pid: number;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
}

/** One enumerated serial port, with the VID/PID allowlist verdict already applied. */
export interface SerialPortDescriptor {
  name: string;
  kind: string;
  isSupported: boolean;
  supportReason: string;
  usb: UsbPortMetadata | null;
}

/** `list_serial_ports`. */
export interface SerialPortListResponse {
  status: SerialCommandStatus;
  ports: SerialPortDescriptor[];
}

/**
 * Current serial connection state. `portName` is the port that was opened and
 * is `null` whenever `connected` is false; a refused or failed attempt's name
 * appears only in `status.details`, as `port="..."`.
 */
export interface SerialConnectionStatus {
  portName: string | null;
  connected: boolean;
  status: SerialCommandStatus;
  updatedAtUnixMs: number;
  /** The PONG answered to the connect-time PING. Absent when the device did
   *  not answer or answered garbage — unknown firmware, and connect still
   *  succeeds. */
  firmware?: SerialFirmwareInfo;
}

/** One step of `run_serial_health_check`. */
export interface HealthStepResult {
  step: DeviceHealthStep;
  pass: boolean;
  code: SerialHealthStepWireCode;
  message: string;
  details: string | null;
}

/**
 * `run_serial_health_check`. The three handshake fields are `null` unless the
 * HANDSHAKE step completed with `SERIAL_HEALTH_OK` — not run yet,
 * `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`, `SERIAL_HEALTH_PROTOCOL_ERROR`, or legacy
 * firmware with no profile byte all leave them `null`.
 */
export interface HealthCheckResult {
  pass: boolean;
  steps: HealthStepResult[];
  checkedAtUnixMs: number;
  /** Wall-clock latency of the handshake round trip in milliseconds. */
  roundTripMs: number | null;
  /** Firmware self-reported version, e.g. `"1.4"`. */
  firmwareVersion: string | null;
  /**
   * Firmware profile **advertised by the device** in the PONG profile byte.
   * Distinct from `ShellState.firmwareProfile`, the user-selected encoder: the
   * Settings UI compares the two so the dropdown can disable the incompatible
   * option (Bug H4 — Adalight silently no-ops on USB while Hue keeps
   * streaming). `null` means "unknown — do not gate the profile dropdown";
   * only a concrete value carries authority for disabling the mismatched one.
   */
  advertisedFirmwareProfile: FirmwareProfile | null;
  /** The whole accepted PONG, pixel layout included. Absent on the same terms. */
  firmware?: SerialFirmwareInfo;
}

/** A health step as the UI holds it: a wire step, or the one the frontend mints
 * when no health-check bridge was injected ({@link HEALTH_CHECK_NOT_AVAILABLE}). */
export type HealthStepView = Omit<HealthStepResult, "code"> & { code: SerialHealthStepCode };

/** A health check as the UI holds it — see {@link HealthStepView}. */
export type HealthCheckView = Omit<HealthCheckResult, "steps"> & { steps: HealthStepView[] };

// ---------------------------------------------------------------------------
// Sink reference (TS mirror of the Rust `LedSink` trait)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WLED UDP sink
// ---------------------------------------------------------------------------

/** `ddp` (default) or realtime UDP with byte 0 = 2. Past DRGB's 490-LED
 * ceiling the encoder switches byte 0 to 4 (DNRGB) and chunks — transport
 * detail, deliberately not a third enum member. */
export const WLED_PROTOCOL = {
  DDP: "ddp",
  DRGB: "drgb",
} as const;

export type WledProtocol = (typeof WLED_PROTOCOL)[keyof typeof WLED_PROTOCOL];

/** Coerce a persisted protocol to a value the union still admits. `"warls"`
 * predates its removal; it maps to `drgb`, the same realtime UDP transport on
 * the same port. Anything else falls back to the DDP default. */
export function normalizeWledProtocol(value: unknown): WledProtocol {
  if (value === WLED_PROTOCOL.DRGB || value === "warls") return WLED_PROTOCOL.DRGB;
  return WLED_PROTOCOL.DDP;
}

/**
 * Persisted configuration for a WLED UDP sink.
 *
 * `ledCount` mirrors the bridge-reported value at connect time and is checked
 * at every reconnect — a mismatch surfaces `WLED_LED_COUNT_MISMATCH` so the
 * user can re-trim their virtual strip before frames go out.
 */
export interface WledUdpSinkConfig {
  /** WLED instance IP (IPv4 or IPv6 textual form). */
  ip: string;
  /** UDP port. Default {@link WLED_DEFAULT_DDP_PORT} for `ddp`,
   * {@link WLED_DEFAULT_REALTIME_PORT} for `drgb`. */
  port: number;
  /** Number of LEDs reported by the WLED instance. */
  ledCount: number;
  protocol: WledProtocol;
}

/** Default UDP port for the DDP wire protocol used by WLED. */
export const WLED_DEFAULT_DDP_PORT = 4048 as const;

/** Default UDP port for WLED's realtime UDP family (`drgb` and its DNRGB
 * promotion). Shared with the notifier, and user-remappable on the device —
 * `/json/info.udpport` is the authority, not this default. */
export const WLED_DEFAULT_REALTIME_PORT = 21324 as const;

/**
 * Snapshot of a WLED instance returned by `discover_wled_devices`.
 *
 * Mirrors the shape of the bridge's `/json/info` HTTP endpoint so the
 * frontend can render a meaningful card in the device picker without a
 * second round-trip. `mac` / `name` / `version` are best-effort — older
 * WLED builds may omit them.
 */
export interface WledDeviceInfo {
  ip: string;
  mac?: string | null;
  ledCount: number;
  name?: string | null;
  version?: string | null;
}

/** Snapshot from `get_wled_sink_status`. `sink` is `null` once a serial connect has evicted WLED, even while `lastWledSink` stays populated. */
export interface WledSinkStatus {
  connected: boolean;
  sink: WledUdpSinkConfig | null;
}

/** Response from `test_wled_bridge`. The numeric fields carry what the status
 * code alone cannot, so the UI never parses `status.details`. */
export interface WledTestResponse {
  status: WledCommandStatus;
  /** Host-side duration of the `send_to` call. Not a round trip: UDP has no
   * ACK, and this excludes network flight and WLED's own processing. */
  sendLatencyMs?: number | null;
  /** LED count the user configured. Populated on `WLED_LED_COUNT_MISMATCH`. */
  requestedLedCount?: number | null;
  /** `/json/info.leds.count`. Populated on `WLED_LED_COUNT_MISMATCH` so the UI
   * can offer a one-click "trust the bridge" resync. */
  deviceLedCount?: number | null;
  /** `/json/info.udpport`. Populated on `WLED_REALTIME_PORT_MISMATCH`. */
  deviceRealtimePort?: number | null;
}

/** Non-fatal notice from `set_lighting_mode`: the stream started, but the frame
 * length does not match the sink, so part of the strip will not track. Rides
 * the result instead of replacing its success code — half a strip beats none. */
export interface WledLiveFrameAdvisory {
  code: typeof WLED_STATUS.LIVE_LED_COUNT_MISMATCH;
  message: string;
  /** LEDs per frame, derived from `ledCalibration.totalLeds` (1 when absent). */
  frameLedCount: number;
  /** `WledUdpSinkConfig.ledCount` held by the active sink registry. */
  sinkLedCount: number;
}

/**
 * Status codes returned by the WLED command surface. Same coded-status
 * pattern as the rest of the device contract: never throw, always a
 * `status.code` discriminator.
 */
export const WLED_STATUS = {
  /** `discover_wled_devices` succeeded; payload contains the one probed `WledDeviceInfo`. */
  DISCOVERY_OK: "WLED_DISCOVERY_OK",
  /** The probed IP did not respond to `/json/info` within the 2s HTTP timeout. */
  DISCOVERY_TIMEOUT: "WLED_DISCOVERY_TIMEOUT",
  /** `connect_wled_sink` / `test_wled_bridge` could not reach the configured IP. */
  BRIDGE_UNREACHABLE: "WLED_BRIDGE_UNREACHABLE",
  /**
   * The bridge replied but rejected our wire protocol (e.g. user picked
   * DDP against a 0.8.x WLED build that only speaks WARLS). User must
   * pick the alternate protocol on the same port.
   */
  PROTOCOL_MISMATCH: "WLED_PROTOCOL_MISMATCH",
  /**
   * The bridge advertised a `ledCount` different from the persisted
   * `WledUdpSinkConfig.ledCount`. Surfaces both numbers so the UI can
   * offer a one-click "trust the bridge" re-sync.
   */
  LED_COUNT_MISMATCH: "WLED_LED_COUNT_MISMATCH",
  /**
   * The supplied IP address failed SSRF hardening (PR #31, since widened).
   * Triggered for non-parseable strings AND for parseable-but-rejected
   * ranges: loopback (127.x), unspecified (0.0.0.0), multicast (224.x/4),
   * broadcast (255.255.255.255). Distinct from `BRIDGE_UNREACHABLE` which
   * means the address parsed fine but no WLED device responded.
   */
  INVALID_IP: "WLED_INVALID_IP",
  /**
   * `connect_wled_sink` received a `led_count` of 0, which is not a
   * valid strip configuration. The user must enter a positive LED count
   * before connecting.
   */
  INVALID_LED_COUNT: "WLED_INVALID_LED_COUNT",
  /** `connect_wled_sink` promoted the instance to the active sink. */
  CONNECT_OK: "WLED_CONNECT_OK",
  /** Frame sent and `/json/info.live` read back `true`. The only test outcome
   * that claims delivery. */
  TEST_LIVE_CONFIRMED: "WLED_TEST_LIVE_CONFIRMED",
  /** Reachable over HTTP, count matched, frame written to the socket — but the
   * `live` read-back did not confirm. Does NOT claim the LEDs changed. */
  TEST_SENT_UNCONFIRMED: "WLED_TEST_SENT_UNCONFIRMED",
  /** Configured port is not the device's `/json/info.udpport` (or not 4048 for
   * `ddp`). Fails closed — the frame would go where nothing listens. */
  REALTIME_PORT_MISMATCH: "WLED_REALTIME_PORT_MISMATCH",
  /** Live counterpart of {@link WLED_STATUS.LED_COUNT_MISMATCH}, which refuses
   * at connect. Off-wire for commands — see {@link WledLiveFrameAdvisory}. */
  LIVE_LED_COUNT_MISMATCH: "WLED_LIVE_LED_COUNT_MISMATCH",
  /** The test packet could not be written to the socket. */
  TEST_SEND_FAILED: "WLED_TEST_SEND_FAILED",
  /** Connection refused / network-level error probing the configured IP. */
  DISCOVERY_UNREACHABLE: "WLED_DISCOVERY_UNREACHABLE",
  /** The HTTP client could not be constructed — a local fault, not a bridge one. */
  CLIENT_BUILD_FAILED: "WLED_CLIENT_BUILD_FAILED",
  /** A send was attempted before `connect_wled_sink` established the sink. */
  SINK_NOT_STARTED: "WLED_SINK_NOT_STARTED",
  /** The `spawn_blocking` worker behind the probe died. A local fault: the
   * device was never reached, so it says nothing about the bridge. */
  DISCOVERY_WORKER_FAILED: "WLED_DISCOVERY_WORKER_FAILED",
  /** Same, for the test worker. */
  TEST_WORKER_FAILED: "WLED_TEST_WORKER_FAILED",
  /** Same, for `connect_wled_sink`'s worker: no sink was registered. */
  CONNECT_WORKER_FAILED: "WLED_CONNECT_WORKER_FAILED",
} as const;

export type WledStatusCode = (typeof WLED_STATUS)[keyof typeof WLED_STATUS];

/** Exactly what `wled_discovery.rs` puts on a WLED command `status`.
 * `SINK_NOT_STARTED` is an `Err(String)` prefix from `wled_sink.rs` and
 * `LIVE_LED_COUNT_MISMATCH` rides the mode-apply result, so neither can ever
 * reach a `switch (status.code)` here. */
export type WledWireStatusCode = Exclude<
  WledStatusCode,
  typeof WLED_STATUS.SINK_NOT_STARTED | typeof WLED_STATUS.LIVE_LED_COUNT_MISMATCH
>;

export type WledCommandStatus = CommandStatusOf<WledWireStatusCode>;

/** `discover_wled_devices` — every WLED instance found at (or probed on) the address. */
export interface WledDiscoveryResponse {
  status: WledCommandStatus;
  devices: WledDeviceInfo[];
}

/** `connect_wled_sink`. */
export interface WledConnectResponse {
  status: WledCommandStatus;
}
