import { describe, expect, it, vi } from "vitest";

import type { SerialPortListResponse } from "./deviceConnectionApi";
import { createDeviceConnectionController } from "./useDeviceConnection";

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

describe("selection memory", () => {
  it("persists lastSuccessfulPort only after successful connect", async () => {
    const persistLastSuccessfulPort = vi.fn();
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
      connectSerialPort: vi.fn().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_OK",
          message: "Connected",
          details: null,
        },
      }),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort,
    });

    await controller.initialize();
    await controller.connectSelectedPort();

    expect(persistLastSuccessfulPort).toHaveBeenCalledWith("COM3");
    expect(controller.getState().lastSuccessfulPort).toBe("COM3");
  });

  it("does not persist when connect attempt fails", async () => {
    const persistLastSuccessfulPort = vi.fn();
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
      connectSerialPort: vi.fn().mockResolvedValue({
        connected: false,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_FAILED",
          message: "Failed",
          details: "busy",
        },
      }),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort,
    });

    await controller.initialize();
    await controller.connectSelectedPort();

    expect(persistLastSuccessfulPort).not.toHaveBeenCalled();
    expect(controller.getState().lastSuccessfulPort).toBeUndefined();
  });
});
