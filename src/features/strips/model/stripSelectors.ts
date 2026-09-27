import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import type { ShellState } from "@/shared/contracts/shell";
import type { LedStrip } from "@/shared/contracts/strips";

import { legacyStripsOf } from "./legacyStrips";
import { readStoredStrips } from "./storedStrips";

/** What a strip read needs from a loaded state. */
export type StripSource = Pick<ShellState, "ledStrips" | "colorCorrection" | "roomMap">;

/** `ledStrips` when the state holds it; a file not yet migrated is read through its legacy keys. */
export function stripsOf(state: StripSource): LedStrip[] {
  return state.ledStrips != null ? readStoredStrips(state.ledStrips) : legacyStripsOf(state);
}

/** The strip a setting with no strip named applies to: the first one enabled. */
export function primaryStrip(strips: readonly LedStrip[]): LedStrip | undefined {
  return strips.find((strip) => strip.enabled);
}

export function primaryStripOf(state: StripSource): LedStrip | undefined {
  return primaryStrip(stripsOf(state));
}

/** The port a launch reconnects, whether or not its strip is the primary one. */
export function savedSerialPort(state: StripSource): string | undefined {
  for (const strip of stripsOf(state)) {
    if (strip.transport?.kind === "serial") return strip.transport.portName;
  }
  return undefined;
}

/** The WLED device a launch binds again, whether or not its strip is the primary one. */
export function savedWledSink(state: StripSource): WledUdpSinkConfig | undefined {
  for (const strip of stripsOf(state)) {
    if (strip.transport?.kind === "wled") return strip.transport.sink;
  }
  return undefined;
}
