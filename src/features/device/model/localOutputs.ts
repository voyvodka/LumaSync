import type { DrivenOutputRef, LocalOutputsSnapshot, WledOutputStatus } from "@/shared/contracts/device";

import type { LocalSink } from "../localSink";
import type { DevicePort } from "../types";

/** The bound WLED device, or `null`. */
export function wledOutput(snapshot: LocalOutputsSnapshot | null): WledOutputStatus | null {
  const entry = snapshot?.outputs.find((output) => output.kind === "wled");
  return entry?.kind === "wled" ? entry : null;
}

/** Two `driven` refs name the same output. */
export function sameDriven(a: DrivenOutputRef | null, b: DrivenOutputRef | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "serial") return b.kind === "serial" && a.portName === b.portName;
  return b.kind === "wled" && a.ip === b.ip;
}

/**
 * The output the "usb" channel drives, named for the UI. Taken from the snapshot's `driven` — Rust's
 * rule — never worked out here: a copy of the rule is how the two sides once disagreed about which
 * of a strip and a WLED device wins.
 */
export function localSinkOf(driven: DrivenOutputRef | null, ports: readonly DevicePort[]): LocalSink | null {
  if (driven === null) return null;
  if (driven.kind === "wled") return { transport: "wled", id: driven.ip };
  const product = ports.find((port) => port.portName === driven.portName)?.product;
  return product
    ? { transport: "serial", id: driven.portName, product }
    : { transport: "serial", id: driven.portName };
}
