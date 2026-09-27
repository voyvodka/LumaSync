import { createStore, useStoreSelector } from "@/shared/lib/store";

import { ensureStripForPort } from "../model/usbStripRoster";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";

type Connector = Pick<
  UseDeviceConnectionResult,
  "connectedPort" | "lastSuccessfulPort" | "selectPort" | "connectSelectedPort"
>;

/** Ports whose room-map placement could not be written after a connect, until one is. */
const rosterFailed = createStore<ReadonlySet<string>>(new Set());

function markRoster(portName: string, failed: boolean): void {
  const current = rosterFailed.get();
  if (current.has(portName) === failed) return;
  const next = new Set(current);
  if (failed) next.add(portName);
  else next.delete(portName);
  rosterFailed.set(next);
}

/**
 * A connect the user asked for: the port, then its strip in the room map's roster. The roster
 * follows only such a connect, never a launch or replug reconnect, so a setup never gains a strip
 * nobody added (`ui-and-shell.md`, "Devices → USB has one add path").
 */
export async function connectAsUser(
  device: Connector,
  portName: string,
  ensure: typeof ensureStripForPort = ensureStripForPort,
): Promise<boolean> {
  // Read before the connect overwrites it: the port that drove the strip until now decides whether
  // an unlinked placement is this one's.
  const previousPort = device.connectedPort ?? device.lastSuccessfulPort ?? null;
  device.selectPort(portName);
  const connected = await device.connectSelectedPort();
  if (!connected) return false;
  try {
    await ensure(portName, previousPort);
    markRoster(portName, false);
  } catch (error) {
    console.error("[LumaSync] adding the connected strip to the room map failed:", error);
    markRoster(portName, true);
  }
  return true;
}

export function useRosterFailed(portName: string): boolean {
  return useStoreSelector(rosterFailed, (failed) => failed.has(portName));
}
