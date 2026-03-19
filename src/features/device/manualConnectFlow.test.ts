import { describe, expect, it, vi } from "vitest";

import type { SerialPortListResponse } from "./deviceConnectionApi";
import { createDeviceConnectionController } from "./useDeviceConnection";

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

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
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
      listSerialPorts: vi.fn().mockResolvedValue(
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
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      initialLastSuccessfulPort: "COM7",
    });

    await controller.initialize();

    expect(controller.getState().selectedPort).toBe("COM7");
  });

  it("does not connect on selection change; connects only on explicit handler", async () => {
    const connectSerialPort = vi.fn().mockResolvedValue({
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
      listSerialPorts: vi.fn().mockResolvedValue(
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
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
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

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      initialLastSuccessfulPort: "COM7",
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

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      initialLastSuccessfulPort: "COM5",
    });

    await controller.initialize();
    expect(controller.getState().selectedPort).toBeNull();

    await controller.refreshPorts();

    expect(controller.getState().selectedPort).toBe("COM5");
    expect(controller.getState().statusCard).toBeNull();
  });
});
