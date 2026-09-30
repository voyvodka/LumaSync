import {
  DEVICE_ERROR_CODES,
  type DrivenOutputRef,
  type LocalOutputsSnapshot,
  type SerialOutputStatus,
  type WledOutputStatus,
} from "@/shared/contracts/device";

import type { LocalSink } from "../localSink";
import type { DevicePort } from "../types";

/** The bound WLED device, or `null`. */
export function wledOutput(snapshot: LocalOutputsSnapshot | null): WledOutputStatus | null {
  const entry = snapshot?.outputs.find((output) => output.kind === "wled");
  return entry?.kind === "wled" ? entry : null;
}

/** The serial port's registry entry, or `null` when Rust has none for it. */
export function serialEntry(snapshot: LocalOutputsSnapshot | null, portName: string): SerialOutputStatus | null {
  const entry = snapshot?.outputs.find((output) => output.kind === "serial" && output.portName === portName);
  return entry?.kind === "serial" ? entry : null;
}

/** The strip the app shows as connected, or `null`: the driven one when a strip is driven, else the
 *  first connected by name (a WLED device drives, a strip waits beside it). */
export function connectedSerialPort(snapshot: LocalOutputsSnapshot | null): string | null {
  if (snapshot?.driven?.kind === "serial") return snapshot.driven.portName;
  const entry = snapshot?.outputs.find((output) => output.kind === "serial" && output.connected);
  return entry?.kind === "serial" ? entry.portName : null;
}

/** Any local output — a strip or a WLED device — is connected. */
export function anyLocalConnected(snapshot: LocalOutputsSnapshot | null): boolean {
  return snapshot?.outputs.some((output) => output.connected) ?? false;
}

/**
 * How the last local output went: `unplugged` when a strip's port disappeared, `released` when it was
 * let go of or replaced. Only an unplug takes the "usb" target out of the saved choice.
 */
export type LocalLoss = "unplugged" | "released";

/** What `next` lost against `prev`, `null` when nothing that was connected stopped being. */
export function classifyLoss(prev: LocalOutputsSnapshot | null, next: LocalOutputsSnapshot): LocalLoss | null {
  if (prev === null) return null;
  let loss: LocalLoss | null = null;
  for (const before of prev.outputs) {
    if (!before.connected) continue;
    if (before.kind === "wled") {
      if (wledOutput(next)?.ip !== before.ip) loss ??= "released";
      continue;
    }
    const after = serialEntry(next, before.portName);
    if (after?.connected) continue;
    if (after?.status.code === DEVICE_ERROR_CODES.PORT_NOT_FOUND) return "unplugged";
    loss ??= "released";
  }
  return loss;
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
export function localSinkOf(
  driven: DrivenOutputRef | null,
  ports: readonly DevicePort[],
  wledReachable = true,
): LocalSink | null {
  if (driven === null) return null;
  if (driven.kind === "wled") {
    return wledReachable ? { transport: "wled", id: driven.ip } : { transport: "wled", id: driven.ip, reachable: false };
  }
  const product = ports.find((port) => port.portName === driven.portName)?.product;
  return product
    ? { transport: "serial", id: driven.portName, product }
    : { transport: "serial", id: driven.portName };
}
