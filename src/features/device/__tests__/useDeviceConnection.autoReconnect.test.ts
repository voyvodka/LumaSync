/**
 * useDeviceConnection.autoReconnect.test.ts
 *
 * Bug 10D regression — PORT_UNSUPPORTED / PORT_NOT_FOUND boot-reconnect path.
 *
 * Scope: `createDeviceConnectionController` — the pure controller factory
 * powering both the React hook and the test suite. Tests exercise the
 * `tryAutoReconnect` path directly through `initialize()` with
 * `autoReconnectOnInit: true`, using an isolated `createConnectionEventBus`
 * instance per scenario so cross-test state cannot leak.
 *
 * Tauri boundary is NOT mocked here because `createDeviceConnectionController`
 * accepts injected deps (listSerialPorts, connectSerialPort, etc.) — the tests
 * drive the deps directly without going through `invoke`.
 */

import { describe, expect, it, vi } from "vitest";

import { createConnectionEventBus, type ConnectionEvent } from "../connectionEvents";
import type { SerialConnectionStatus, SerialPortListResponse } from "../deviceConnectionApi";
import { createDeviceConnectionController } from "../useDeviceConnection";

// ---------------------------------------------------------------------------
// Helpers shared across scenarios
// ---------------------------------------------------------------------------

function listResponse(ports: SerialPortListResponse["ports"]): SerialPortListResponse {
  return {
    status: { code: "LIST_PORTS_OK", message: "ok", details: null },
    ports,
  };
}

const BLUETOOTH_PORT: SerialPortListResponse["ports"][number] = {
  name: "/dev/cu.Bluetooth-Incoming-Port",
  kind: "unknown",
  isSupported: false,
  supportReason: "Non-USB port rejected by allowlist",
  usb: null,
};

const SUPPORTED_PORT: SerialPortListResponse["ports"][number] = {
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

/**
 * Minimal controller factory for the auto-reconnect path.
 * Only `connectSerialPort` matters for these tests — other deps are stubs.
 */
function makeController(
  persistedPort: string,
  portInScan: SerialPortListResponse["ports"][number],
  connectResult: SerialConnectionStatus,
  bus = createConnectionEventBus(),
) {
  const connectSerialPort = vi.fn().mockResolvedValue(connectResult);

  const controller = createDeviceConnectionController({
    listSerialPorts: vi.fn().mockResolvedValue(listResponse([portInScan])),
    connectSerialPort,
    getSerialConnectionStatus: vi.fn().mockResolvedValue({
      connected: false,
      portName: null,
      updatedAtUnixMs: Date.now(),
      status: { code: "NO_ACTIVE_SESSION", message: "Idle", details: null },
    }),
    persistLastSuccessfulPort: vi.fn(),
    initialLastSuccessfulPort: persistedPort,
    autoReconnectOnInit: true,
    connectionEvents: bus,
  });

  return { controller, connectSerialPort, bus };
}

// ---------------------------------------------------------------------------
// PORT_UNSUPPORTED — allowlist rejection
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — PORT_UNSUPPORTED signal", () => {
  it("emits connected:false + unsupportedReason:PORT_UNSUPPORTED when Rust rejects with PORT_UNSUPPORTED", async () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const { controller } = makeController(
      "/dev/cu.Bluetooth-Incoming-Port",
      BLUETOOTH_PORT,
      {
        connected: false,
        portName: "/dev/cu.Bluetooth-Incoming-Port",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "PORT_UNSUPPORTED",
          message: "Port is not on the USB allowlist",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    expect(received).toHaveLength(1);
    expect(received[0].connected).toBe(false);
    expect(received[0].portName).toBe("/dev/cu.Bluetooth-Incoming-Port");
    expect(received[0].unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("does NOT emit unsupportedReason for transient rejection codes (CONNECT_BUSY)", async () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const { controller } = makeController(
      "COM3",
      SUPPORTED_PORT,
      {
        connected: false,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_BUSY",
          message: "Port is in use",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    // Bus must receive no event at all for transient rejections — we don't
    // want to strip "usb" from selectedOutputTargets on a transient failure.
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PORT_NOT_FOUND — port enumerated but connect returns NOT_FOUND
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — PORT_NOT_FOUND signal", () => {
  it("emits connected:false + unsupportedReason:PORT_NOT_FOUND when Rust returns PORT_NOT_FOUND", async () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const { controller } = makeController(
      "COM3",
      SUPPORTED_PORT,
      {
        connected: false,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "PORT_NOT_FOUND",
          message: "Serial port path no longer enumerates",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    expect(received).toHaveLength(1);
    expect(received[0].connected).toBe(false);
    expect(received[0].portName).toBe("COM3");
    expect(received[0].unsupportedReason).toBe("PORT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Successful reconnect — NO unsupportedReason emitted
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — successful path does not emit unsupportedReason", () => {
  it("emits connected:true with no unsupportedReason on a clean CONNECT_OK", async () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const { controller } = makeController(
      "COM3",
      SUPPORTED_PORT,
      {
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_OK",
          message: "Connected",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    expect(received).toHaveLength(1);
    expect(received[0].connected).toBe(true);
    expect(received[0].portName).toBe("COM3");
    expect(received[0].unsupportedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No retry loop — single emit per boot-reconnect
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — single attempt per initialize()", () => {
  it("calls connectSerialPort exactly once even when the response is PORT_UNSUPPORTED", async () => {
    const bus = createConnectionEventBus();
    const { controller, connectSerialPort } = makeController(
      "/dev/cu.Bluetooth-Incoming-Port",
      BLUETOOTH_PORT,
      {
        connected: false,
        portName: "/dev/cu.Bluetooth-Incoming-Port",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "PORT_UNSUPPORTED",
          message: "Port rejected",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    // Auto-reconnect is a one-shot on init; it must NOT retry in a loop.
    expect(connectSerialPort).toHaveBeenCalledTimes(1);
  });

  it("leaves the controller operation state idle after the rejection", async () => {
    const bus = createConnectionEventBus();
    const { controller } = makeController(
      "/dev/cu.Bluetooth-Incoming-Port",
      BLUETOOTH_PORT,
      {
        connected: false,
        portName: "/dev/cu.Bluetooth-Incoming-Port",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "PORT_UNSUPPORTED",
          message: "Port rejected",
          details: null,
        },
      },
      bus,
    );

    await controller.initialize();

    const state = controller.getState();
    expect(state.activeOperation).toBe("idle");
    expect(state.isConnecting).toBe(false);
    expect(state.connectedPort).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No bus provided — should not throw
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — connectionEvents not provided", () => {
  it("silently skips the emit when no connectionEvents bus is injected", async () => {
    // Controller without a bus dep — mirrors plain factory call with no event plumbing.
    const connectSerialPort = vi.fn().mockResolvedValue({
      connected: false,
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      updatedAtUnixMs: Date.now(),
      status: {
        code: "PORT_UNSUPPORTED",
        message: "Port rejected",
        details: null,
      },
    });

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn().mockResolvedValue(listResponse([BLUETOOTH_PORT])),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NO_ACTIVE_SESSION", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn(),
      initialLastSuccessfulPort: "/dev/cu.Bluetooth-Incoming-Port",
      autoReconnectOnInit: true,
      // connectionEvents deliberately omitted
    });

    // Must not throw
    await expect(controller.initialize()).resolves.toBeUndefined();
    expect(connectSerialPort).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// autoReconnectOnInit: false — no event emitted (default opt-out)
// ---------------------------------------------------------------------------

describe("tryAutoReconnect — feature flag off", () => {
  it("emits nothing when autoReconnectOnInit is false, even when port is PORT_UNSUPPORTED", async () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const connectSerialPort = vi.fn().mockResolvedValue({
      connected: false,
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      updatedAtUnixMs: Date.now(),
      status: {
        code: "PORT_UNSUPPORTED",
        message: "Port rejected",
        details: null,
      },
    });

    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn().mockResolvedValue(listResponse([BLUETOOTH_PORT])),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: Date.now(),
        status: { code: "NO_ACTIVE_SESSION", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn(),
      initialLastSuccessfulPort: "/dev/cu.Bluetooth-Incoming-Port",
      autoReconnectOnInit: false,
      connectionEvents: bus,
    });

    await controller.initialize();

    // Flag is off — connect never attempted, no event emitted.
    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
});
