import { describe, expect, it, vi } from "vitest";

import type { SerialPortListResponse } from "../deviceConnectionApi";
import { fakeRegistry, withRegistry } from "./support/fakeRegistry";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import { createConnectionEventBus } from "../connectionEvents";
import type { DeviceConnectionControllerDeps } from "@/features/device/state/connectionTypes";

/**
 * Bug 10A + 10B regression tests.
 *
 * 10A — `initialize()` must auto-reconnect when the persisted port is
 *       still visible AND Rust reports `connected: false`. Daily-use
 *       requirement: app launch should not require a manual re-pair.
 *
 * 10B — A successful pair in one controller must reach the sibling
 *       controllers, so the App-level hook (LIGHTS / StatusBar) flips
 *       `isConnected` without a WebView reload. They all follow the registry.
 */

function listResponse(ports: SerialPortListResponse["ports"]): SerialPortListResponse {
  return {
    status: { code: "LIST_PORTS_OK", message: "ok", details: null },
    ports,
  };
}

const SUPPORTED_PORT = {
  name: "COM3",
  kind: "usb",
  isSupported: true,
  supportReason: "Supported USB serial adapter",
  usb: {
    vid: 0x1a86,
    pid: 0x7523,
    manufacturer: "QinHeng",
    product: "USB Serial",
    serialNumber: null,
  },
};

describe("Bug 10A — auto-reconnect on init", () => {
  it("calls connectSerialPort with the persisted port when Rust reports disconnected", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
      connected: true,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: { code: "CONNECT_OK", message: "Connected", details: null },
    });

    const persistLastSuccessfulPort = vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>();

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      persistLastSuccessfulPort,
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    }));

    await controller.initialize();

    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(connectSerialPort).toHaveBeenCalledWith("COM3");

    const state = controller.getState();
    expect(state.connectedPort).toBe("COM3");
    expect(state.lastSuccessfulPort).toBe("COM3");
    expect(state.status).toBe("connected");
    // Persistence happens on the auto-connect success path so the next
    // launch keeps the same port memory.
    expect(persistLastSuccessfulPort).toHaveBeenCalledWith("COM3");
  });

  it("skips auto-reconnect when persisted port is no longer visible", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();

    const controller = createDeviceConnectionController(withRegistry({
      // Persisted port is "COM3" but the live scan only sees "COM7".
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            ...SUPPORTED_PORT,
            name: "COM7",
          },
        ]),
      ),
      connectSerialPort,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    }));

    await controller.initialize();

    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(controller.getState().connectedPort).toBeNull();
  });

  it("skips auto-reconnect when feature flag is off", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      // autoReconnectOnInit defaults to false — keeps existing fixtures
      // (recoveryFlow, manualConnectFlow, etc.) opt-out.
    }));

    await controller.initialize();

    expect(connectSerialPort).not.toHaveBeenCalled();
  });

  it("falls through silently when Rust rejects the auto-connect attempt", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
      connected: false,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: { code: "CONNECT_TIMEOUT", message: "Timed out opening the port", details: null },
    });

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    }));

    await controller.initialize();

    // Connect was attempted exactly once, and we landed back in IDLE so
    // the user can see the manual-pair UI without an error toast.
    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().isConnecting).toBe(false);
    expect(controller.getState().activeOperation).toBe("idle");
  });

  it("reads a strip Rust already holds connected, and does not connect it again", async () => {
    // Cold-launch path where Rust kept the session warm (e.g. fast restart
    // window). Auto-reconnect is a no-op because the registry already says CONNECTED.
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    }, fakeRegistry({ connected: "COM3" })));

    await controller.initialize();

    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(controller.getState().connectedPort).toBe("COM3");
  });
});

describe("Bug 10B — sibling controllers stay in step", () => {
  it("emits a connection event after a manual pair succeeds", async () => {
    const events = createConnectionEventBus();
    const observed: Array<{ portName: string; connected: boolean }> = [];
    events.subscribe((event) => observed.push(event));

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    }));

    await controller.initialize();
    controller.selectPort("COM3");
    await controller.connectSelectedPort();

    expect(observed).toEqual([{ portName: "COM3", connected: true, userInitiated: true }]);
  });

  // The LED Setup nudge keys on `userInitiated`; the launch reconnect fired it every boot.
  it("announces the boot auto-reconnect as a plain connect, not the user's", async () => {
    const events = createConnectionEventBus();
    const observed: Array<{ portName: string; connected: boolean }> = [];
    events.subscribe((event) => observed.push(event));

    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
      connectionEvents: events,
    }));

    await controller.initialize();

    expect(controller.getState().connectedPort).toBe("COM3");
    expect(observed).toEqual([{ portName: "COM3", connected: true }]);
  });

  it("a pair in one mount reaches the other through the registry", async () => {
    const registry = fakeRegistry();
    const connected = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
      connected: true,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: { code: "CONNECT_OK", message: "Connected", details: null },
    });
    const deps = {
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    };
    const devices = createDeviceConnectionController(withRegistry({ ...deps, connectSerialPort: connected }, registry));
    const shell = createDeviceConnectionController(
      withRegistry({ ...deps, connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>() }, registry),
    );
    await devices.initialize();
    await shell.initialize();
    expect(shell.getState().connectedPort).toBeNull();

    devices.selectPort("COM3");
    await devices.connectSelectedPort();

    expect(shell.getState().connectedPort).toBe("COM3");
    expect(shell.getState().status).toBe("connected");
  });

  it("a disposed controller no longer follows the registry", async () => {
    const registry = fakeRegistry();
    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    }, registry));
    await controller.initialize();

    controller.dispose();
    registry.connect("COM3");

    expect(controller.getState().connectedPort).toBeNull();
  });
});

describe("the registry decides what is connected", () => {
  const base = () => ({
    listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
      listResponse([SUPPORTED_PORT, { ...SUPPORTED_PORT, name: "COM4" }]),
    ),
    persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
  });

  // Rust keeps driving COM3 when an attempt on COM4 fails; the UI used to read nothing connected.
  it("a failed attempt on another port leaves the connected strip connected", async () => {
    const registry = fakeRegistry({ connected: "COM3" });
    const controller = createDeviceConnectionController(withRegistry({
      ...base(),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_IO_ERROR", message: "busy", details: null },
      }),
    }, registry));
    await controller.initialize();

    controller.selectPort("COM4");
    expect(await controller.connectSelectedPort()).toBe(false);

    expect(controller.getState().connectedPort).toBe("COM3");
    expect(controller.getState().statusCard?.code).toBe("CONNECT_IO_ERROR");
  });

  it("another output taking the strip's place reads as information, not a failure", async () => {
    const registry = fakeRegistry({ connected: "COM3" });
    const controller = createDeviceConnectionController(withRegistry({
      ...base(),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
    }, registry));
    await controller.initialize();

    registry.bindWled("192.168.1.42");

    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().statusCard).toMatchObject({ variant: "info", code: "DISCONNECTED" });
  });

  it("an unplug reads as the port gone", async () => {
    const registry = fakeRegistry({ connected: "COM3" });
    const controller = createDeviceConnectionController(withRegistry({
      ...base(),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
    }, registry));
    await controller.initialize();

    registry.unplug("COM3");

    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().statusCard).toMatchObject({ variant: "error", code: "PORT_NOT_FOUND" });
  });

  // A connect whose port another output took before the answer landed is not a success.
  it("a connect Rust no longer holds by the time it answers is not reported connected", async () => {
    const registry = fakeRegistry();
    // Not `withRegistry`: its recording would connect the port again after the bind.
    const controller = createDeviceConnectionController({
      ...base(),
      localOutputs: registry.outputs,
      connectSerialPort: async (portName) => {
        registry.connect(portName);
        registry.bindWled("192.168.1.42");
        return {
          connected: true,
          portName,
          updatedAtUnixMs: Date.now(),
          status: { code: "CONNECT_OK", message: "Connected", details: null },
        };
      },
    });
    await controller.initialize();
    controller.selectPort("COM3");

    expect(await controller.connectSelectedPort()).toBe(false);
    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().status).toBe("ready");
  });
});

// StrictMode's rehearsal unmount disposes a controller while its initial scan
// is still in flight; subscribing after that left a listener nothing removed.
describe("a controller disposed while it initialises", () => {
  it("never keeps a listener on the connection bus", async () => {
    const inner = createConnectionEventBus();
    let subscribed = 0;
    const events = {
      emit: inner.emit,
      subscribe: (listener: Parameters<typeof inner.subscribe>[0]) => {
        subscribed += 1;
        const unsubscribe = inner.subscribe(listener);
        return () => {
          subscribed -= 1;
          unsubscribe();
        };
      },
    };
    let finishScan!: (response: SerialPortListResponse) => void;
    const controller = createDeviceConnectionController(withRegistry({
      listSerialPorts: vi
        .fn<DeviceConnectionControllerDeps["listSerialPorts"]>()
        .mockReturnValue(new Promise((resolve) => { finishScan = resolve; })),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    }));

    const initializing = controller.initialize();
    controller.dispose();
    finishScan(listResponse([SUPPORTED_PORT]));
    await initializing;

    expect(subscribed).toBe(0);
  });
});
