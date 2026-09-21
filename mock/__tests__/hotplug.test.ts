/**
 * The point of these helpers is that they publish, not that they mutate.
 * A version that only edited the world would pass any test written against
 * `getWorld()` and still leave the app insisting the cable is plugged in —
 * which is exactly the state this module was written to fix. So every case
 * here subscribes to the real bus.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { connectionEvents } from "../../src/features/device/connectionEvents";
import type { ConnectionEvent } from "../../src/features/device/connectionEvents";
import { wledSinkEvents } from "../../src/features/device/wledSinkEvents";
import type { WledRestoreOutcome } from "../../src/features/device/wledSinkRestore";
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

beforeEach(() => {
  setWorld(SCENARIOS.furnished.build());
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
  it("announces an unplug on the bus the controller listens to", () => {
    setSerialConnected(PORT, false);

    expect(getWorld().serial.connectedPort).toBeNull();
    // Without this emission nothing re-reads the status and the UI keeps
    // showing a connected strip that is no longer there.
    expect(connectionSeen).toEqual([{ portName: PORT, connected: false }]);
  });

  it("announces a plug-in and records the port as the last successful one", () => {
    setSerialConnected(PORT, false);
    connectionSeen.length = 0;

    setSerialConnected(PORT, true);

    expect(getWorld().serial.connectedPort).toBe(PORT);
    expect(getWorld().shellState.lastSuccessfulPort).toBe(PORT);
    expect(connectionSeen).toEqual([{ portName: PORT, connected: true }]);
  });

  it("carries the port name on an unplug, so a listener keyed to another cable ignores it", () => {
    setSerialConnected("/dev/cu.other", false);
    expect(connectionSeen[0]?.portName).toBe("/dev/cu.other");
  });

  it("keeps the last successful port across an unplug", () => {
    setSerialConnected(PORT, true);
    setSerialConnected(PORT, false);
    // The auto-reconnect hint is the whole reason the field exists; clearing
    // it on unplug would mean the strip is never re-found on the next launch.
    expect(getWorld().shellState.lastSuccessfulPort).toBe(PORT);
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
    // App drops `usb` from the output targets on a rejection and does not on
    // a transient disconnect, so the two must not produce the same event.
    setSerialConnected(PORT, false);
    rejectSerialPort(PORT, "PORT_NOT_FOUND");

    expect(connectionSeen[0]?.unsupportedReason).toBeUndefined();
    expect(connectionSeen[1]?.unsupportedReason).toBe("PORT_NOT_FOUND");
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
    expect(getWorld().shellState.lastWledSink).toBeUndefined();
    // `failed` would make the picker render a fault the user did not cause.
    expect(last(wledSeen)).toEqual({ kind: "no-saved-device" });
  });

  it("ignores a host that is not in the world", () => {
    setWledBound("10.0.0.1", true);
    expect(getWorld().wled.connectedHost).toBe(WLED_HOST);
    expect(wledSeen).toEqual([]);
  });
});
