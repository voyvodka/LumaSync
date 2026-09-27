import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import type { LedStrip } from "@/shared/contracts/strips";

import { stripsFromLegacy, type LegacyStripSource } from "./legacyStrips";

/** The strip a setting with no strip named applies to: the first one enabled. */
export function primaryStrip(
  strips: readonly LedStrip[],
): LedStrip | undefined {
  return strips.find((strip) => strip.enabled);
}

export function primaryStripOf(state: LegacyStripSource): LedStrip | undefined {
  return primaryStrip(stripsFromLegacy(state));
}

/** The port a launch reconnects, whether or not its strip is the primary one. */
export function savedSerialPort(state: LegacyStripSource): string | undefined {
  for (const strip of stripsFromLegacy(state)) {
    if (strip.transport?.kind === "serial") return strip.transport.portName;
  }
  return undefined;
}

/** The WLED device a launch binds again, whether or not its strip is the primary one. */
export function savedWledSink(
  state: LegacyStripSource,
): WledUdpSinkConfig | undefined {
  for (const strip of stripsFromLegacy(state)) {
    if (strip.transport?.kind === "wled") return strip.transport.sink;
  }
  return undefined;
}
