/**
 * The point of these helpers is that they publish, not that they mutate.
 * A version that only edited the world would pass any test written against
 * `getWorld()` and still leave the app insisting the cable is plugged in —
 * which is exactly the state this module was written to fix. So every case
 * here reads what was announced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitted } = vi.hoisted(() => ({ emitted: [] as Array<{ event: string; payload: unknown }> }));
vi.mock("../events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../events")>()),
  emitMockEvent: async (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
  },
}));

import { DEVICE_EVENTS, type LocalOutputsSnapshot, type SerialPortsChangedEvent } from "../../src/shared/contracts/device";
import { installLocalOutputsAnnouncer, localOutputsSnapshot } from "../localOutputs";

import { connectionEvents } from "../../src/features/device/connectionEvents";
import type { ConnectionEvent } from "../../src/features/device/connectionEvents";
import { wledSinkEvents } from "../../src/features/device/wledSinkEvents";
import type { WledRestoreOutcome } from "../../src/features/device/wledSinkRestore";
import { savedSerialPort, savedWledSink } from "../../src/features/strips/model/stripSelectors";
import { rejectSerialPort, setSerialConnected, setWledBound } from "../hotplug";
import { SCENARIOS } from "../scenarios";
import { getWorld, setWorld } from "../state";

const PORT = "/dev/cu.usbserial-1420";
const WLED_HOST = "192.168.1.42";

let connectionSeen: ConnectionEvent[];
let wledSeen: WledRestoreOutcome[];
/** `Array.prototype.at` is past this tsconfig's lib target. */
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];
let unsubscribe: Array<() => void>;

let announcing = false;

const serialEntry = (snapshot: LocalOutputsSnapshot) => snapshot.outputs.find((output) => output.kind === "serial");

beforeEach(() => {
  setWorld(SCENARIOS.furnished.build());
  if (!announcing) {
    installLocalOutputsAnnouncer();
    announcing = true;
  }
  emitted.length = 0;
  connectionSeen = [];
  wledSeen = [];
  unsubscribe = [
    connectionEvents.subscribe((event) => connectionSeen.push(event)),
    wledSinkEvents.subscribe((outcome) => wledSeen.push(outcome)),
  ];
  return () => {
    for (const off of unsubscribe) off();
  };
});

describe("serial hot-plug", () => {
  it("an unplug leaves the strip's entry reading the port gone, as Rust's registry does", () => {
    setSerialConnected(PORT, false);

    expect(getWorld().serial.connectedPort).toBeNull();
    // The app tells an unplug from a release by this code; without the entry it read as a release.
    expect(serialEntry(localOutputsSnapshot())).toMatchObject({
      portName: PORT,
      connected: false,
      status: { code: "PORT_NOT_FOUND" },
    });
  });

  // A reader that sees the port go learns from the registry, already announced, whether the strip went.
  it("announces the registry before the watcher's ports", () => {
    setSerialConnected(PORT, false);

    expect(emitted.map((entry) => entry.event)).toEqual([
      DEVICE_EVENTS.LOCAL_OUTPUTS_CHANGED,
      DEVICE_EVENTS.SERIAL_PORTS_CHANGED,
    ]);
    const ports = emitted[1]?.payload as SerialPortsChangedEvent;
    expect(ports.lost).toEqual([PORT]);
  });

  it("a plug-in connects the port and records it as the saved one", () => {
    setSerialConnected(PORT, false);

    setSerialConnected(PORT, true);

    expect(getWorld().serial.connectedPort).toBe(PORT);
    expect(savedSerialPort(getWorld().shellState)).toBe(PORT);
    expect(serialEntry(localOutputsSnapshot())).toMatchObject({ portName: PORT, connected: true });
  });

  it("names the port on an unplug, so a listener keyed to another cable ignores it", () => {
    setSerialConnected("/dev/cu.other", false);

    const ports = emitted.find((entry) => entry.event === DEVICE_EVENTS.SERIAL_PORTS_CHANGED)?.payload;
    expect((ports as SerialPortsChangedEvent).lost).toEqual(["/dev/cu.other"]);
  });

  it("keeps the last successful port across an unplug", () => {
    setSerialConnected(PORT, true);
    setSerialConnected(PORT, false);
    // The auto-reconnect hint is the whole reason the field exists; clearing
    // it on unplug would mean the strip is never re-found on the next launch.
    expect(savedSerialPort(getWorld().shellState)).toBe(PORT);
  });
});

describe("boot-time port rejection", () => {
  it.each(["PORT_UNSUPPORTED", "PORT_NOT_FOUND"] as const)(
    "stamps %s as the structural-unavailability reason",
    (reason) => {
      rejectSerialPort(PORT, reason);
      expect(connectionSeen).toEqual([
        { portName: PORT, connected: false, unsupportedReason: reason },
      ]);
    },
  );

  it("is distinguishable from a plain unplug", () => {
    // App drops `usb` from the output targets on a rejection; an unplug reaches it through the
    // registry instead, so only the rejection is on the bus.
    setSerialConnected(PORT, false);
    rejectSerialPort(PORT, "PORT_NOT_FOUND");

    expect(connectionSeen).toEqual([{ portName: PORT, connected: false, unsupportedReason: "PORT_NOT_FOUND" }]);
  });
});

describe("WLED binding", () => {
  it("publishes the restored sink so the picker and the dock both see it", () => {
    setWledBound(WLED_HOST, true);

    expect(getWorld().wled.connectedHost).toBe(WLED_HOST);
    expect(last(wledSeen)).toEqual({
      kind: "restored",
      sink: { ip: WLED_HOST, port: 4048, ledCount: 120, protocol: "ddp" },
    });
  });

  it("unbinding is not a failure", () => {
    setWledBound(WLED_HOST, false);

    expect(getWorld().wled.connectedHost).toBeNull();
    expect(savedWledSink(getWorld().shellState)).toBeUndefined();
    // `failed` would make the picker render a fault the user did not cause.
    expect(last(wledSeen)).toEqual({ kind: "no-saved-device" });
  });

  it("ignores a host that is not in the world", () => {
    setWledBound("10.0.0.1", true);
    expect(getWorld().wled.connectedHost).toBe(WLED_HOST);
    expect(wledSeen).toEqual([]);
  });
});
