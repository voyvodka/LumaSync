import { describe, expect, it, vi } from "vitest";

import { FIRMWARE_PIXEL_LAYOUT, FIRMWARE_PROFILE } from "@/shared/contracts/device";
import type { HealthCheckResult, SerialPortListResponse } from "../deviceConnectionApi";
import type { FirmwareProfileEventBus } from "../firmwareProfileEvents";
import { createDeviceConnectionController } from "../state/deviceConnectionController";
import type { DeviceConnectionControllerDeps } from "@/features/device/state/connectionTypes";

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

function healthResult(pass: boolean): HealthCheckResult {
  return {
    pass,
    checkedAtUnixMs: Date.now(),
    roundTripMs: null,
    firmwareVersion: null,
    advertisedFirmwareProfile: null,
    steps: [
      {
        step: "PORT_VISIBLE",
        pass: true,
        code: "PORT_VISIBLE",
        message: "visible",
        details: null,
      },
      {
        step: "PORT_SUPPORTED",
        pass,
        code: pass ? "PORT_SUPPORTED" : "PORT_UNSUPPORTED",
        message: pass ? "supported" : "not supported",
        details: pass ? null : "choose another port",
      },
      {
        step: "CONNECT_AND_VERIFY",
        pass,
        code: pass ? "CONNECT_OK" : "CONNECT_FAILED",
        message: pass ? "connected" : "failed",
        details: pass ? null : "check cable",
      },
    ],
  };
}

describe("health check flow", () => {
  it("returns deterministic 3-step pass result", async () => {
    const runSerialHealthCheck = vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockResolvedValue(healthResult(true));
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck,
    });

    await controller.initialize();
    await controller.runHealthCheck();

    expect(runSerialHealthCheck).toHaveBeenCalledWith("COM4");
    expect(controller.getState().latestHealthCheck?.pass).toBe(true);
    expect(controller.getState().latestHealthCheck?.steps).toHaveLength(3);
    expect(controller.getState().latestHealthCheck?.steps.map((step) => step.step)).toEqual([
      "PORT_VISIBLE",
      "PORT_SUPPORTED",
      "CONNECT_AND_VERIFY",
    ]);
    expect(controller.getState().statusCard?.code).toBe("HEALTH_CHECK_PASS");
  });

  it("returns fail summary with step-level outcomes", async () => {
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck: vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockResolvedValue(healthResult(false)),
    });

    await controller.initialize();
    await controller.runHealthCheck();

    expect(controller.getState().latestHealthCheck?.pass).toBe(false);
    expect(controller.getState().statusCard?.code).toBe("HEALTH_CHECK_FAIL");
    expect(controller.getState().statusCard?.variant).toBe("error");
    expect(controller.getState().statusCard?.details).toBe("not supported");
  });

  it("rejects manual connect while health check is in progress", async () => {
    let resolveHealth!: (value: HealthCheckResult) => void;
    const pendingHealthResult = new Promise<HealthCheckResult>((resolve) => {
      resolveHealth = resolve;
    });
    const runSerialHealthCheck = vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockImplementation(() => pendingHealthResult);

    const connectSerialPort = vi.fn<DeviceConnectionControllerDeps["connectSerialPort"]>();
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck,
    });

    await controller.initialize();
    const pendingHealth = controller.runHealthCheck();
    await controller.connectSelectedPort();

    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(controller.getState().isHealthChecking).toBe(true);

    resolveHealth(healthResult(true));
    await pendingHealth;
  });

  it("broadcasts the advertised firmware profile on the firmwareProfileEvents bus", async () => {
    const emit = vi.fn();
    const firmwareProfileEvents: FirmwareProfileEventBus = { emit, subscribe: vi.fn() };
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck: vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockResolvedValue({
        ...healthResult(true),
        advertisedFirmwareProfile: FIRMWARE_PROFILE.LUMASYNC_V1,
        firmware: {
          version: "1.4",
          versionRaw: 0x0104,
          profile: FIRMWARE_PROFILE.LUMASYNC_V1,
          pixelLayout: FIRMWARE_PIXEL_LAYOUT.RGBW,
        },
      }),
      firmwareProfileEvents,
    });

    await controller.initialize();
    await controller.runHealthCheck();

    expect(emit).toHaveBeenCalledWith({
      advertisedFirmwareProfile: FIRMWARE_PROFILE.LUMASYNC_V1,
      advertisedPixelLayout: FIRMWARE_PIXEL_LAYOUT.RGBW,
    });
  });

  it("broadcasts undefined when the handshake step didn't complete", async () => {
    const emit = vi.fn();
    const firmwareProfileEvents: FirmwareProfileEventBus = { emit, subscribe: vi.fn() };
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck: vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockResolvedValue(healthResult(false)),
      firmwareProfileEvents,
    });

    await controller.initialize();
    await controller.runHealthCheck();

    expect(emit).toHaveBeenCalledWith({
      advertisedFirmwareProfile: undefined,
      advertisedPixelLayout: undefined,
    });
  });

  it("does not emit when the health check throws", async () => {
    const emit = vi.fn();
    const firmwareProfileEvents: FirmwareProfileEventBus = { emit, subscribe: vi.fn() };
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn<DeviceConnectionControllerDeps["listSerialPorts"]>().mockResolvedValue(
        listResponse([
          {
            name: "COM4",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
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
      runSerialHealthCheck: vi.fn<Required<DeviceConnectionControllerDeps>["runSerialHealthCheck"]>().mockRejectedValue(new Error("IPC dropped")),
      firmwareProfileEvents,
    });

    await controller.initialize();
    await controller.runHealthCheck();

    expect(emit).not.toHaveBeenCalled();
  });
});
