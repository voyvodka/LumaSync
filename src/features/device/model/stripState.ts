import type { TranslationKey } from "@/features/i18n/catalogue";
import {
  DEVICE_ERROR_CODES,
  SERIAL_CONNECT_STATUS,
  type SerialOutputStatus,
} from "@/shared/contracts/device";

/** Where a strip stands, in one word. A closed set: a new state fails to compile until it says how it reads. */
export type StripState =
  | "connecting"
  | "connected"
  | "unlit"
  | "reconnecting"
  | "disconnected"
  | "busy"
  | "replug"
  | "firmwareMismatch";

/** The dot beside the word. */
export type StripTone = "live" | "idle" | "busy" | "warn" | "error";

/** The one action the state asks for, at rest; `null` when there is nothing to do. */
export type StripAction = "connect" | "retry" | "flash" | "settings" | null;

export interface StripStateView {
  word: TranslationKey;
  tone: StripTone;
  action: StripAction;
}

export const STRIP_STATE_VIEW = {
  connecting: { word: "device:strip.state.connecting", tone: "busy", action: null },
  connected: { word: "device:strip.state.connected", tone: "live", action: "flash" },
  unlit: { word: "device:strip.state.unlit", tone: "warn", action: "retry" },
  reconnecting: { word: "device:strip.state.reconnecting", tone: "busy", action: null },
  disconnected: { word: "device:strip.state.disconnected", tone: "idle", action: "connect" },
  busy: { word: "device:strip.state.busy", tone: "warn", action: "retry" },
  replug: { word: "device:strip.state.replug", tone: "error", action: "retry" },
  firmwareMismatch: { word: "device:strip.state.firmwareMismatch", tone: "warn", action: "settings" },
} as const satisfies Record<StripState, StripStateView>;

export interface SerialStripFacts {
  /** A connect of this strip's port is running. */
  connecting: boolean;
  /** The registry's entry for the strip's port; `null` when Rust has none. */
  entry: SerialOutputStatus | null;
  /** The user said the strip did not light when it was flashed, and nothing has lit it since. */
  unlit: boolean;
  /** The firmware answered with a profile other than the one chosen. */
  firmwareMismatch: boolean;
}

/**
 * The state of a serial strip. A strip whose port went away is waiting to come back: the shell
 * reconnects it when the port reappears. A port another app holds reads as busy; one the OS refuses
 * until the cable is re-plugged says so.
 */
export function serialStripState(facts: SerialStripFacts): StripState {
  if (facts.connecting) return "connecting";
  const entry = facts.entry;
  if (entry?.connected) {
    if (facts.firmwareMismatch) return "firmwareMismatch";
    return facts.unlit ? "unlit" : "connected";
  }
  switch (entry?.status.code) {
    case DEVICE_ERROR_CODES.PORT_NOT_FOUND:
      return "reconnecting";
    case SERIAL_CONNECT_STATUS.REPLUG_REQUIRED:
      return "replug";
    case SERIAL_CONNECT_STATUS.IO_ERROR:
    case SERIAL_CONNECT_STATUS.PERMISSION_DENIED:
      return "busy";
    default:
      return "disconnected";
  }
}

/** The state of a WLED strip: it answers or it does not; there is no cable to wait for. */
export function wledStripState(facts: { connecting: boolean; bound: boolean; unlit: boolean }): StripState {
  if (facts.connecting) return "connecting";
  if (!facts.bound) return "disconnected";
  return facts.unlit ? "unlit" : "connected";
}
