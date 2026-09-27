import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SerialCommandStatusCode, SerialConnectionStatus, SerialPortsChangedEvent } from "@/shared/contracts/device";
import type { SerialPortListResponse } from "../deviceConnectionApi";
import { createConnectionEventBus } from "../connectionEvents";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import { fakeRegistry, withRegistry } from "./support/fakeRegistry";
import type { DeviceConnectionControllerDeps } from "../state/connectionTypes";

const PORT = {
  name: "COM3",
  kind: "usb",
  isSupported: true,
  supportReason: "Supported USB serial adapter",
  usb: { vid: 0x1a86, pid: 0x7523, manufacturer: "QinHeng", product: "USB Serial", serialNumber: null },
};

const status = (code: string, connected: boolean): SerialConnectionStatus => ({
  connected,
  portName: connected ? "COM3" : null,
  updatedAtUnixMs: 0,
  status: { code: code as SerialCommandStatusCode, message: code, details: null },
});

const list = (ports: SerialPortListResponse["ports"]): SerialPortListResponse => ({
  status: { code: "LIST_PORTS_OK", message: "ok", details: null },
  ports,
});

function build(options: {
  connectedAtStart: boolean;
  reconnectOnReplug: boolean;
  connects?: string[];
  readSavedSerialPort?: () => Promise<string | undefined>;
}) {
  let emitWatch: (event: SerialPortsChangedEvent) => void = () => {};
  const results = [...(options.connects ?? ["CONNECT_OK"])];
  const registry = fakeRegistry(options.connectedAtStart ? { connected: "COM3" } : {});
  const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(async () => {
    const code = results.shift() ?? "CONNECT_OK";
    return status(code, code === "CONNECT_OK");
  });
  const bus = createConnectionEventBus();
  const busEvents: unknown[] = [];
  bus.subscribe((event) => busEvents.push(event));
  const controller = createDeviceConnectionController(withRegistry({
    listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(list([PORT])),
    connectSerialPort,
    persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    initialLastSuccessfulPort: "COM3",
    connectionEvents: bus,
    listenSerialPortsChanged: async (handler) => {
      emitWatch = handler;
      return () => {};
    },
    reconnectOnReplug: options.reconnectOnReplug,
    readSavedSerialPort: options.readSavedSerialPort,
    replugDelayMs: 10,
    replugRetryMs: 20,
  }, registry));
  // Rust announces the registry before the ports, so a reader sees the loss first.
  const watch = (appeared: string[], lost: string[], { registryLoses = true } = {}) => {
    if (registryLoses) for (const port of lost) registry.unplug(port);
    emitWatch({ ports: lost.length ? [] : [PORT], appeared, lost });
  };
  return { controller, connectSerialPort, watch, busEvents };
}

/** Past the timer and every await the reconnect chains after it. */
async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("following the serial port watcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the connection when the connected port goes, and a follower does not reconnect", async () => {
    const { controller, connectSerialPort, watch } = build({ connectedAtStart: true, reconnectOnReplug: false });
    await controller.initialize();
    expect(controller.getState().connectedPort).toBe("COM3");

    watch([], ["COM3"]);
    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().statusCard?.code).toBe("PORT_NOT_FOUND");

    watch(["COM3"], []);
    await settle(100);
    expect(connectSerialPort).not.toHaveBeenCalled();
  });

  // Rust leaves a connect that finished after the listing in place; the UI must agree with it.
  it("keeps a connection Rust kept past the listing", async () => {
    const { controller, watch } = build({ connectedAtStart: true, reconnectOnReplug: false });
    await controller.initialize();

    watch([], ["COM3"], { registryLoses: false });

    expect(controller.getState().connectedPort).toBe("COM3");
  });

  it("leaves a strip moved to WLED this session on WLED", async () => {
    const { controller, connectSerialPort, watch } = build({
      connectedAtStart: false,
      reconnectOnReplug: true,
      readSavedSerialPort: async () => undefined,
    });
    await controller.initialize();

    watch(["COM3"], []);
    await settle(100);

    expect(connectSerialPort).not.toHaveBeenCalled();
  });

  it("drops a pending reconnect when the controller goes away", async () => {
    const { controller, connectSerialPort, watch } = build({ connectedAtStart: false, reconnectOnReplug: true });
    await controller.initialize();

    watch(["COM3"], []);
    controller.dispose();
    await settle(100);

    expect(connectSerialPort).not.toHaveBeenCalled();
  });

  it("brings the saved port back once when it reappears", async () => {
    const { controller, connectSerialPort, watch } = build({ connectedAtStart: false, reconnectOnReplug: true });
    await controller.initialize();

    watch(["COM3"], []);
    await settle(10);

    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().connectedPort).toBe("COM3");
  });

  it("tries once more after a transient failure", async () => {
    const { controller, connectSerialPort, watch } = build({
      connectedAtStart: false,
      reconnectOnReplug: true,
      connects: ["CONNECT_TIMEOUT", "CONNECT_OK"],
    });
    await controller.initialize();

    watch(["COM3"], []);
    await settle(10);
    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    await settle(20);

    expect(connectSerialPort).toHaveBeenCalledTimes(2);
    expect(controller.getState().connectedPort).toBe("COM3");
  });

  // Re-opening a wedged driver is what wedges it.
  it("never retries a port the system refuses until it is re-plugged", async () => {
    const { controller, connectSerialPort, watch } = build({
      connectedAtStart: false,
      reconnectOnReplug: true,
      connects: ["CONNECT_REPLUG_REQUIRED", "CONNECT_OK"],
    });
    await controller.initialize();

    watch(["COM3"], []);
    await settle(100);

    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().statusCard?.code).toBe("CONNECT_REPLUG_REQUIRED");
  });

  // A busy port also reads PORT_NOT_FOUND; at a replug that must not strip USB from the selection.
  it("does not report a replug refusal as the strip being unavailable", async () => {
    const { controller, watch, busEvents } = build({
      connectedAtStart: false,
      reconnectOnReplug: true,
      connects: ["PORT_NOT_FOUND", "PORT_NOT_FOUND"],
    });
    await controller.initialize();

    watch(["COM3"], []);
    await settle(100);

    expect(busEvents.some((event) => (event as { unsupportedReason?: string }).unsupportedReason)).toBe(false);
  });
});
