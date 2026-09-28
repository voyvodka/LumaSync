/**
 * The local-output registry as the mock world holds it: the connected strip and the bound WLED
 * device, with a revision that grows on every change and an announcement like Rust's. Derived from
 * the world rather than kept beside it, so every path that connects, binds, unplugs or forgets —
 * a command, the DevPanel, a scenario switch — announces without having to remember to.
 */
import {
  DEVICE_ERROR_CODES,
  DEVICE_EVENTS,
  SERIAL_CONNECT_STATUS,
  type LocalOutputStatus,
  type LocalOutputsSnapshot,
} from "../src/shared/contracts/device";
import { emitMockEvent } from "./events";
import { status } from "./handlers/status";
import { getWorld, subscribe } from "./state";

let revision = 0;
let heldKey = "";

/** What a reader can see change, so any of it moves the revision; time stamps alone do not. */
function key(): string {
  const { outputs, driven } = localOutputsSnapshot();
  return JSON.stringify({
    outputs: outputs.map((output) => (output.kind === "serial" ? { ...output, updatedAtUnixMs: 0 } : output)),
    driven,
  });
}

export function localOutputsSnapshot(): LocalOutputsSnapshot {
  const { serial, wled } = getWorld();
  const port = serial.ports.find((p) => p.name === serial.connectedPort);
  const device = wled.devices.find((d) => d.host === wled.connectedHost);
  const outputs: LocalOutputStatus[] = [];
  const idle = serial.idleEntry;
  if (idle && idle.portName !== port?.name) {
    outputs.push({
      kind: "serial",
      portName: idle.portName,
      connected: false,
      status: status(idle.code, idle.code === DEVICE_ERROR_CODES.PORT_NOT_FOUND ? "The serial port went away." : "Not connected."),
      firmware: null,
      updatedAtUnixMs: Date.now(),
    });
  }
  if (port !== undefined) {
    outputs.push({
      kind: "serial",
      portName: port.name,
      connected: true,
      status: status(SERIAL_CONNECT_STATUS.OK, "Connected"),
      firmware: null,
      updatedAtUnixMs: Date.now(),
    });
  }
  if (device !== undefined) {
    outputs.push({ kind: "wled", ip: device.host, ledCount: device.ledCount, connected: true });
  }
  // Rust's rule: the earliest connected output.
  const wledDriven = device !== undefined && (port === undefined || serial.connectedFirst === "wled");
  const driven = wledDriven
    ? ({ kind: "wled", ip: device.host } as const)
    : port !== undefined
      ? ({ kind: "serial", portName: port.name } as const)
      : null;
  outputs.sort((a, b) =>
    a.kind === "serial" && b.kind === "serial" ? a.portName.localeCompare(b.portName) : a.kind === "serial" ? -1 : 1,
  );
  return { revision, outputs, driven };
}

/** Starts announcing: the world changes, and the registry's view of it moves with a new revision. */
export function installLocalOutputsAnnouncer(): void {
  heldKey = key();
  subscribe(() => {
    const next = key();
    if (next === heldKey) return;
    heldKey = next;
    revision += 1;
    void emitMockEvent(DEVICE_EVENTS.LOCAL_OUTPUTS_CHANGED, localOutputsSnapshot());
  });
}
