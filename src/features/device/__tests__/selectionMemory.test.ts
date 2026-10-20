import { describe, expect, it, vi } from "vitest";

import { withRegistry } from "./support/fakeRegistry";
import { listResponse } from "./support/portList";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import type { DeviceConnectionControllerDeps } from "@/features/device/state/connectionTypes";

describe("selection memory", () => {
  it("persists lastSuccessfulPort only after successful connect", async () => {
    const persistLastSuccessfulPort = vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>();
    const controller = createDeviceConnectionController(withRegistry({
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
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_OK",
          message: "Connected",
          details: null,
        },
      }),
      persistLastSuccessfulPort,
    }));

    await controller.initialize();
    await controller.connectSelectedPort();

    expect(persistLastSuccessfulPort).toHaveBeenCalledWith("COM3");
    expect(controller.getState().lastSuccessfulPort).toBe("COM3");
  });

  it("does not persist when connect attempt fails", async () => {
    const persistLastSuccessfulPort = vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>();
    const controller = createDeviceConnectionController(withRegistry({
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
      connectSerialPort: vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>().mockResolvedValue({
        connected: false,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: {
          code: "CONNECT_FAILED",
          message: "Failed",
          details: "busy",
        },
      }),
      persistLastSuccessfulPort,
    }));

    await controller.initialize();
    await controller.connectSelectedPort();

    expect(persistLastSuccessfulPort).not.toHaveBeenCalled();
    expect(controller.getState().lastSuccessfulPort).toBeUndefined();
  });
});
