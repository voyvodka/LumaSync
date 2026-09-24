import { describe, expect, it, vi } from "vitest";

import type { SerialPortListResponse } from "../deviceConnectionApi";
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
 * 10B — A successful pair in one controller must propagate to sibling
 *       controllers via the connection-event bus, so the App-level hook
 *       (LIGHTS / StatusBar) flips `isConnected` without a WebView reload.
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

    const getSerialConnectionStatus = vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
      connected: false,
      portName: null,
      updatedAtUnixMs: Date.now(),
      status: { code: "NOT_CONNECTED", message: "Idle", details: null },
    });

    const persistLastSuccessfulPort = vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>();

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      getSerialConnectionStatus,
      persistLastSuccessfulPort,
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    });

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

    const controller = createDeviceConnectionController({
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
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    });

    await controller.initialize();

    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(controller.getState().connectedPort).toBeNull();
  });

  it("skips auto-reconnect when feature flag is off", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      // autoReconnectOnInit defaults to false — keeps existing fixtures
      // (recoveryFlow, manualConnectFlow, etc.) opt-out.
    });

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

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    });

    await controller.initialize();

    // Connect was attempted exactly once, and we landed back in IDLE so
    // the user can see the manual-pair UI without an error toast.
    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().connectedPort).toBeNull();
    expect(controller.getState().isConnecting).toBe(false);
    expect(controller.getState().activeOperation).toBe("idle");
  });

  it("hydrates from getSerialConnectionStatus when Rust already has an active session", async () => {
    // Cold-launch path where Rust kept the session warm (e.g. fast restart
    // window). Auto-reconnect should be a no-op because the hydration step
    // already promotes us to CONNECTED.
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
    });

    await controller.initialize();

    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(controller.getState().connectedPort).toBe("COM3");
  });
});

describe("Bug 10B — sibling controller propagation via connectionEvents", () => {
  it("emits a connection event after a manual pair succeeds", async () => {
    const events = createConnectionEventBus();
    const observed: Array<{ portName: string; connected: boolean }> = [];
    events.subscribe((event) => observed.push(event));

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    });

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

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM3",
      autoReconnectOnInit: true,
      connectionEvents: events,
    });

    await controller.initialize();

    expect(controller.getState().connectedPort).toBe("COM3");
    expect(observed).toEqual([{ portName: "COM3", connected: true }]);
  });

  it("propagates a sibling pair: listener controller hydrates from Rust on emit", async () => {
    const events = createConnectionEventBus();

    // ── Sibling A — the controller doing the pair (DEVICES section) ──
    const siblingAConnect = vi.fn().mockResolvedValue({
      connected: true,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: { code: "CONNECT_OK", message: "Connected", details: null },
    });

    const siblingA = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: siblingAConnect,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    });

    // ── Sibling B — the listener controller (App-level / LIGHTS) ──
    // Its first getSerialConnectionStatus returns disconnected (cold boot,
    // mirrors what the user sees today). After the broadcast it should
    // poll again and Rust now reports CONNECTED, so isConnected flips.
    const siblingBStatusMock = vi
      .fn()
      .mockResolvedValueOnce({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      })
      .mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      });

    const siblingB = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      // Sibling B never calls connectSerialPort itself — it's just observing.
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: siblingBStatusMock,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    });

    await siblingA.initialize();
    await siblingB.initialize();

    // Pre-condition: Sibling B sees disconnected after init.
    expect(siblingB.getState().connectedPort).toBeNull();
    // Initial status poll consumed the first mock value.
    expect(siblingBStatusMock).toHaveBeenCalledTimes(1);

    // User pairs from Sibling A (DEVICES section).
    siblingA.selectPort("COM3");
    await siblingA.connectSelectedPort();

    // Drain the deferred microtask the listener uses (Promise.resolve()).
    await Promise.resolve();
    await Promise.resolve();

    // Sibling B re-polled Rust on the broadcast and flipped CONNECTED.
    expect(siblingBStatusMock).toHaveBeenCalledTimes(2);
    expect(siblingB.getState().connectedPort).toBe("COM3");
    expect(siblingB.getState().status).toBe("connected");
  });

  it("dispose() removes the controller from the broadcast bus", async () => {
    const events = createConnectionEventBus();

    const siblingBStatusMock = vi.fn().mockResolvedValue({
      connected: false,
      portName: null,
      updatedAtUnixMs: Date.now(),
      status: { code: "NOT_CONNECTED", message: "Idle", details: null },
    });

    const sibling = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(listResponse([SUPPORTED_PORT])),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: siblingBStatusMock,
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    });

    await sibling.initialize();
    expect(siblingBStatusMock).toHaveBeenCalledTimes(1);

    sibling.dispose();

    // Emit after dispose: the listener must NOT re-poll.
    events.emit({ portName: "COM3", connected: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(siblingBStatusMock).toHaveBeenCalledTimes(1);
  });
});

// StrictMode's rehearsal unmount disposes a controller while its initial scan
// is still in flight; subscribing after that left a listener nothing removed.
describe("a controller disposed while it initialises", () => {
  it("never subscribes to its siblings", async () => {
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
    const controller = createDeviceConnectionController({
      listSerialPorts: vi
        .fn<DeviceConnectionControllerDeps["listSerialPorts"]>()
        .mockReturnValue(new Promise((resolve) => { finishScan = resolve; })),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      connectionEvents: events,
    });

    const initializing = controller.initialize();
    controller.dispose();
    finishScan(listResponse([SUPPORTED_PORT]));
    await initializing;

    expect(subscribed).toBe(0);
  });
});
