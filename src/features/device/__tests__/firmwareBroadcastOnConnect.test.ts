import { describe, expect, it, vi } from "vitest";

import {
  FIRMWARE_PIXEL_LAYOUT,
  FIRMWARE_PROFILE,
  type SerialFirmwareInfo,
} from "@/shared/contracts/device";
import type { SerialConnectionStatus, SerialPortListResponse } from "../deviceConnectionApi";
import type { FirmwareProfileEventBus } from "../firmwareProfileEvents";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import type { DeviceConnectionControllerDeps } from "../state/connectionTypes";

// Connect PINGs the firmware, so the pickers' markers work without anyone
// running a health check. Every connect path goes through one wrapper.

const PORT = "COM3";

const LISTING: SerialPortListResponse = {
  status: { code: "LIST_PORTS_OK", message: "ok", details: null },
  ports: [
    {
      name: PORT,
      kind: "usb",
      isSupported: true,
      supportReason: "Supported USB serial adapter",
      usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
    },
  ],
};

const RGBW_V1: SerialFirmwareInfo = {
  version: "1.4",
  versionRaw: 0x0104,
  profile: FIRMWARE_PROFILE.LUMASYNC_V1,
  pixelLayout: FIRMWARE_PIXEL_LAYOUT.RGBW,
};

function connected(firmware?: SerialFirmwareInfo): SerialConnectionStatus {
  return {
    connected: true,
    portName: PORT,
    updatedAtUnixMs: 0,
    status: { code: "CONNECT_OK", message: "Connected", details: null },
    ...(firmware ? { firmware } : {}),
  };
}

const DISCONNECTED: SerialConnectionStatus = {
  connected: false,
  portName: null,
  updatedAtUnixMs: 0,
  status: { code: "NOT_CONNECTED", message: "Idle", details: null },
};

function controllerWith(
  connectSerialPort: DeviceConnectionControllerDeps["connectSerialPort"],
  extra: Partial<DeviceConnectionControllerDeps> = {},
) {
  const emit = vi.fn();
  const firmwareProfileEvents: FirmwareProfileEventBus = { emit, subscribe: vi.fn() };
  const controller = createDeviceConnectionController({
    listSerialPorts: vi.fn().mockResolvedValue(LISTING),
    connectSerialPort,
    getSerialConnectionStatus: vi.fn().mockResolvedValue(DISCONNECTED),
    persistLastSuccessfulPort: vi.fn().mockResolvedValue(undefined),
    firmwareProfileEvents,
    ...extra,
  });
  return { controller, emit };
}

async function connectManually(connectSerialPort: DeviceConnectionControllerDeps["connectSerialPort"]) {
  const { controller, emit } = controllerWith(connectSerialPort);
  await controller.initialize();
  controller.selectPort(PORT);
  await controller.connectSelectedPort();
  return emit;
}

describe("firmware broadcast on connect", () => {
  it("broadcasts the PONG's profile and layout after a manual connect", async () => {
    const emit = await connectManually(vi.fn().mockResolvedValue(connected(RGBW_V1)));

    expect(emit).toHaveBeenCalledWith({
      advertisedFirmwareProfile: FIRMWARE_PROFILE.LUMASYNC_V1,
      advertisedPixelLayout: FIRMWARE_PIXEL_LAYOUT.RGBW,
    });
  });

  it("clears the advertisement when the connected device stayed silent", async () => {
    const emit = await connectManually(vi.fn().mockResolvedValue(connected()));

    expect(emit).toHaveBeenCalledWith({
      advertisedFirmwareProfile: undefined,
      advertisedPixelLayout: undefined,
    });
  });

  it("says nothing about firmware when the connect failed", async () => {
    const emit = await connectManually(
      vi.fn().mockResolvedValue({
        ...DISCONNECTED,
        status: { code: "CONNECT_FAILED", message: "Failed", details: 'port="COM3"' },
      }),
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("broadcasts from the boot-time auto-reconnect too", async () => {
    const { controller, emit } = controllerWith(vi.fn().mockResolvedValue(connected(RGBW_V1)), {
      initialLastSuccessfulPort: PORT,
      autoReconnectOnInit: true,
    });

    await controller.initialize();

    expect(emit).toHaveBeenCalledWith({
      advertisedFirmwareProfile: FIRMWARE_PROFILE.LUMASYNC_V1,
      advertisedPixelLayout: FIRMWARE_PIXEL_LAYOUT.RGBW,
    });
  });
});
