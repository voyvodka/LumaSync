/**
 * Coded-status injection.
 *
 * Commands in this app never throw — they return a status code inside a
 * well-formed response, and the UI branches on that code. So the panel's first
 * failure mechanism was wrong in a way that mattered: rejecting the promise
 * exercised a path the app does not actually take, which is worse than no
 * control because it looks like a test and is not one.
 *
 * The code a command may carry is read off its own response type rather than
 * restated, so a picker can only offer codes that command can actually
 * produce, and a contract change breaks the build instead of leaving a stale
 * list behind.
 */

import type { CommandStatusOf } from "../../src/shared/contracts/status";
import type { CommandResponse } from "./responses";

/**
 * The status code an envelope carries, wherever it keeps it.
 *
 * Three arms because the tree has exactly three envelope shapes: the shared
 * `CommandStatusOf<T>`; an inline `status: { code, message, details? }`; and a
 * flat top-level `code`, which the preview and capture results use.
 */
export type StatusCodeOf<R> = R extends { status: CommandStatusOf<infer C> }
  ? C
  : R extends { status: { code: infer C extends string } }
    ? C
    : R extends { code: infer C extends string }
      ? C
      : never;

export type InjectableCode<C extends keyof CommandResponse> = StatusCodeOf<CommandResponse[C]>;

/**
 * The codes worth offering, per command.
 *
 * Deliberately a curated subset rather than every declared code. Most codes in
 * a family are indistinguishable on screen, and a picker with forty entries is
 * a picker nobody reads. Each entry below drives a visibly different path —
 * and each is typed, so a code that a command cannot produce will not compile.
 */
export const OFFERED_CODES = {
  list_serial_ports: ["LIST_PORTS_OK", "LIST_PORTS_FAILED"],
  connect_serial_port: [
    "CONNECT_OK",
    "CONNECT_FAILED",
    "CONNECT_PERMISSION_DENIED",
    "CONNECT_TIMEOUT",
    "PORT_UNSUPPORTED",
  ],
  discover_wled_devices: ["WLED_DISCOVERY_OK", "WLED_DISCOVERY_TIMEOUT", "WLED_DISCOVERY_UNREACHABLE"],
  connect_wled_sink: ["WLED_CONNECT_OK", "WLED_BRIDGE_UNREACHABLE", "WLED_LED_COUNT_MISMATCH"],
  // Three live outcomes, and only one means the device echoed `live: true`.
  // Conflating them is the worst lie available here, because it is the code
  // the UI trusts most.
  test_wled_bridge: [
    "WLED_TEST_LIVE_CONFIRMED",
    "WLED_TEST_SENT_UNCONFIRMED",
    "WLED_TEST_SEND_FAILED",
  ],
  discover_hue_bridges: ["HUE_DISCOVERY_OK", "HUE_DISCOVERY_EMPTY", "HUE_DISCOVERY_FAILED"],
  pair_hue_bridge: ["HUE_PAIRING_OK", "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED", "HUE_PAIRING_FAILED"],
  get_hue_area_channels: [
    "HUE_AREA_CHANNELS_OK",
    "HUE_AREA_CHANNELS_EMPTY",
    "HUE_AREA_CHANNELS_UNREACHABLE",
    "AUTH_INVALID_RE_PAIR_REQUIRED",
  ],
  update_hue_channel_positions: [
    "HUE_CHANNEL_POSITIONS_UPDATED",
    "CHAN_WB_AREA_NOT_FOUND",
    "CHAN_WB_SCHEMA_REJECTED",
    "AUTH_INVALID_RE_PAIR_REQUIRED",
  ],
  start_hue_stream: [
    "HUE_STREAM_RUNNING_DTLS",
    "HUE_START_NOOP_ALREADY_ACTIVE",
    "TRANSIENT_RETRY_SCHEDULED",
    "TRANSIENT_RETRY_EXHAUSTED",
    "AUTH_INVALID_CREDENTIALS",
    "CONFIG_NOT_READY_GATE_BLOCKED",
  ],
  set_lighting_mode: [
    "AMBILIGHT_MODE_STARTED",
    "AMBILIGHT_MODE_START_FAILED",
    "SOLID_MODE_APPLIED",
    "SOLID_MODE_HUE_OUTPUT_SKIPPED",
    "DEVICE_NOT_CONNECTED",
    "HUE_NOT_READY",
  ],
} satisfies { [K in keyof CommandResponse]?: InjectableCode<K>[] };

export type InjectableCommand = keyof typeof OFFERED_CODES;

/**
 * Rewrites the status code on a fixture's answer, leaving the rest of the
 * payload alone.
 *
 * That rule is deliberate: a status code is not a whole response, and
 * `get_hue_area_channels` returning `UNREACHABLE` still has to hand back a
 * well-formed object with a `channels` field, because the UI reads both. An
 * injected code that emptied the payload would be testing a shape the backend
 * never sends.
 */
export function applyForcedCode(response: unknown, code: string): unknown {
  if (response === null || typeof response !== "object") return response;
  const record = response as Record<string, unknown>;

  if (typeof record.status === "object" && record.status !== null) {
    return { ...record, status: { ...(record.status as object), code } };
  }
  if (typeof record.code === "string") {
    return { ...record, code };
  }
  return response;
}
