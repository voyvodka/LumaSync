import { describe, expect, it, vi } from "vitest";

import type { SerialPortListResponse } from "../deviceConnectionApi";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import type { DeviceConnectionControllerDeps } from "@/features/device/state/connectionTypes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function listResponse(ports: SerialPortListResponse["ports"]): SerialPortListResponse {
  return {
    status: {
      code: "LIST_PORTS_OK",
      message: "ok",
      details: null,
    },
    ports,
  };
}

describe("manual connect flow", () => {
  it("runs auto-scan on init and keeps current list during refresh scanning", async () => {
    const initial = listResponse([
      {
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
      },
    ]);
    const pendingRefresh = deferred<SerialPortListResponse>();

    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(pendingRefresh.promise);

    let nowMs = 0;
    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      refreshMinIntervalMs: 250,
      refreshVisibleWaitMs: 0,
      now: () => { nowMs += 500; return nowMs; },
    });

    await controller.initialize();
    expect(listSerialPorts).toHaveBeenCalledTimes(1);

    const beforeRefreshPorts = controller.getState().ports;
    const refreshPromise = controller.refreshPorts();

    expect(controller.getState().status).toBe("scanning");
    expect(controller.getState().ports).toEqual(beforeRefreshPorts);

    pendingRefresh.resolve(initial);
    await refreshPromise;
  });

  it("resolves initial selection to remembered successful port when present", async () => {
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: null,
              product: null,
              serialNumber: null,
            },
          },
          {
            name: "COM7",
            kind: "unknown",
            isSupported: false,
            supportReason: "Unknown serial port type",
            usb: null,
          },
        ]),
      ),
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM7",
    });

    await controller.initialize();

    expect(controller.getState().selectedPort).toBe("COM7");
  });

  it("does not connect on selection change; connects only on explicit handler", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
      connected: true,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: {
        code: "CONNECT_OK",
        message: "Serial port connection attempt succeeded.",
        details: null,
      },
    });
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: null,
              product: null,
              serialNumber: null,
            },
          },
        ]),
      ),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    });

    await controller.initialize();
    controller.selectPort("COM3");

    expect(connectSerialPort).not.toHaveBeenCalled();

    await controller.connectSelectedPort();

    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().connectedPort).toBe("COM3");
    expect(controller.getState().canConnect).toBe(true);
    expect(controller.getState().selectedPort).toBe("COM3");
  });

  it("releases the operation gate and surfaces a coded error when connect rejects", async () => {
    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockRejectedValue(new Error("device disconnected"));
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: null,
              product: null,
              serialNumber: null,
            },
          },
        ]),
      ),
      connectSerialPort,
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    });

    await controller.initialize();
    controller.selectPort("COM3");

    // The Devices page adds a strip to the roster only on `true`.
    await expect(controller.connectSelectedPort()).resolves.toBe(false);

    expect(connectSerialPort).toHaveBeenCalledTimes(1);
    expect(controller.getState().activeOperation).toBe("idle");
    expect(controller.getState().isConnecting).toBe(false);
    expect(controller.getState().status).toBe("error");
    expect(controller.getState().statusCard?.variant).toBe("error");
    expect(controller.getState().statusCard?.code).toBe("CONNECT_FAILED");

    // The gate must be released: a follow-up connect attempt has to actually
    // run rather than being swallowed by a still-stuck activeOperation.
    connectSerialPort.mockResolvedValueOnce({
      connected: true,
      portName: "COM3",
      updatedAtUnixMs: Date.now(),
      status: {
        code: "CONNECT_OK",
        message: "Serial port connection attempt succeeded.",
        details: null,
      },
    });

    await expect(controller.connectSelectedPort()).resolves.toBe(true);

    expect(connectSerialPort).toHaveBeenCalledTimes(2);
    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().connectedPort).toBe("COM3");
  });

  // An uncoded rejection used to be the only kind: its code is kept now, so
  // the banner can say "port busy" in Turkish instead of Rust's English.
  it("keeps the code of a coded rejection", async () => {
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ]),
      ),
      connectSerialPort: vi
        .fn<DeviceConnectionControllerDeps["connectSerialPort"]>()
        .mockRejectedValue("CONNECT_PERMISSION_DENIED: Resource busy (os error 16)"),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
    });

    await controller.initialize();
    controller.selectPort("COM3");
    await expect(controller.connectSelectedPort()).resolves.toBe(false);

    expect(controller.getState().statusCard).toMatchObject({
      variant: "error",
      code: "CONNECT_PERMISSION_DENIED",
      details: "Resource busy (os error 16)",
    });
  });

  it("clears stale selection when selected port is missing after refresh", async () => {
    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: null,
              product: null,
              serialNumber: null,
            },
          },
          {
            name: "COM7",
            kind: "unknown",
            isSupported: false,
            supportReason: "Unknown serial port type",
            usb: null,
          },
        ]),
      )
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: null,
              product: null,
              serialNumber: null,
            },
          },
        ]),
      );

    let nowMs = 0;
    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM7",
      refreshMinIntervalMs: 250,
      refreshVisibleWaitMs: 0,
      now: () => { nowMs += 500; return nowMs; },
    });

    await controller.initialize();
    await controller.refreshPorts();

    expect(controller.getState().selectedPort).toBeNull();
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().statusCard?.variant).toBe("info");
    expect(controller.getState().statusCard?.code).toBe("SELECTED_PORT_MISSING");
  });

  it("reselects remembered port when it reappears after refresh", async () => {
    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM5",
            kind: "unknown",
            isSupported: false,
            supportReason: "Unknown serial port type",
            usb: null,
          },
        ]),
      );

    let nowMs = 0;
    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      initialLastSuccessfulPort: "COM5",
      refreshMinIntervalMs: 250,
      refreshVisibleWaitMs: 0,
      now: () => { nowMs += 500; return nowMs; },
    });

    await controller.initialize();
    expect(controller.getState().selectedPort).toBeNull();

    await controller.refreshPorts();

    expect(controller.getState().selectedPort).toBe("COM5");
    expect(controller.getState().statusCard).toBeNull();
  });

  it("refresh throttles rapid retries before the minimum interval", async () => {
    let nowMs = 1_000;
    const response = listResponse([
      {
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
      },
    ]);

    const listSerialPorts = vi.fn<() => Promise<SerialPortListResponse>>().mockResolvedValue(response);

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      refreshMinIntervalMs: 250,
      refreshVisibleWaitMs: 0,
      now: () => nowMs,
    });

    await controller.initialize();       // Call #1, lastRefreshAt = 1000
    nowMs += 250;                         // Advance past rate limit window
    await controller.refreshPorts();     // Call #2
    await controller.refreshPorts();     // Rate-limited (nowMs unchanged)

    expect(listSerialPorts).toHaveBeenCalledTimes(2);
  });

  it("refresh exposes info status when a retry is blocked by rate limit", async () => {
    let nowMs = 500;
    const listSerialPorts = vi.fn<() => Promise<SerialPortListResponse>>().mockResolvedValue(
      listResponse([
        {
          name: "COM4",
          kind: "usb",
          isSupported: true,
          supportReason: "Supported USB serial adapter",
          usb: {
            vid: 0x1a86,
            pid: 0x7523,
            manufacturer: null,
            product: null,
            serialNumber: null,
          },
        },
      ]),
    );

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      refreshMinIntervalMs: 250,
      now: () => nowMs,
    });

    await controller.initialize();
    await controller.refreshPorts();
    await controller.refreshPorts();

    expect(controller.getState().isScanning).toBe(false);
    expect(controller.getState().statusCard?.variant).toBe("info");
    expect(controller.getState().statusCard?.code).toBe("REFRESH_RATE_LIMITED");
    expect(controller.getState().statusCard?.message).toBe("Refresh is temporarily limited.");
  });

  it("refresh allows retry again after the minimum interval passes", async () => {
    let nowMs = 2_000;
    const listSerialPorts = vi.fn<() => Promise<SerialPortListResponse>>().mockResolvedValue(
      listResponse([
        {
          name: "COM9",
          kind: "unknown",
          isSupported: false,
          supportReason: "Unknown serial port type",
          usb: null,
        },
      ]),
    );

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>(),
      getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>().mockResolvedValue({
        connected: false,
        portName: null,
        updatedAtUnixMs: 0,
        status: { code: "NOT_CONNECTED", message: "Idle", details: null },
      }),
      persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>(),
      refreshMinIntervalMs: 250,
      refreshVisibleWaitMs: 0,
      now: () => nowMs,
    });

    await controller.initialize();       // Call #1, lastRefreshAt = 2000
    nowMs += 260;                         // Advance past rate limit window
    await controller.refreshPorts();     // Call #2
    await controller.refreshPorts();     // Rate-limited (nowMs unchanged)

    nowMs += 260;
    await controller.refreshPorts();     // Call #3

    expect(listSerialPorts).toHaveBeenCalledTimes(3);
    expect(controller.getState().status).toBe("ready");
  });
});
