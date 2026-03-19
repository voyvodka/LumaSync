import { describe, expect, it, vi } from "vitest";

import type { HealthCheckResult, SerialPortListResponse } from "./deviceConnectionApi";
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

function healthResult(pass: boolean): HealthCheckResult {
  return {
    pass,
    checkedAtUnixMs: Date.now(),
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
    const runSerialHealthCheck = vi.fn().mockResolvedValue(healthResult(true));
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn().mockResolvedValue(
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
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
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
      listSerialPorts: vi.fn().mockResolvedValue(
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
      connectSerialPort: vi.fn(),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      runSerialHealthCheck: vi.fn().mockResolvedValue(healthResult(false)),
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
    const runSerialHealthCheck = vi.fn().mockImplementation(() => pendingHealthResult);

    const connectSerialPort = vi.fn();
    const controller = createDeviceConnectionController({
      listSerialPorts: vi.fn().mockResolvedValue(
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
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
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
});
