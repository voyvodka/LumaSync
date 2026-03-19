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

function createHealthPass(): HealthCheckResult {
  return {
    pass: true,
    checkedAtUnixMs: Date.now(),
    steps: [
      { step: "PORT_VISIBLE", pass: true, code: "OK", message: "ok", details: null },
      { step: "PORT_SUPPORTED", pass: true, code: "OK", message: "ok", details: null },
      { step: "CONNECT_AND_VERIFY", pass: true, code: "OK", message: "ok", details: null },
    ],
  };
}

describe("recovery flow", () => {
  it("starts bounded auto-recovery after disconnect and reconnects when port returns", async () => {
    vi.useFakeTimers();

    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ]),
      )
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ]),
      );

    const connectSerialPort = vi
      .fn()
      .mockResolvedValueOnce({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      })
      .mockResolvedValueOnce({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Recovered", details: null },
      });

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort,
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      runSerialHealthCheck: vi.fn().mockResolvedValue(createHealthPass()),
      refreshMinIntervalMs: 0,
      recoveryFastDelayMs: 10,
      recoveryRetryDelayMs: 20,
      recoveryMaxAttempts: 3,
    });

    await controller.initialize();
    await controller.connectSelectedPort();
    const refreshPromise = controller.refreshPorts();
    await vi.advanceTimersByTimeAsync(600);
    await refreshPromise;

    expect(controller.getState().status).toBe("reconnecting");
    expect(controller.getState().isReconnecting).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().isReconnecting).toBe(false);
    expect(controller.getState().statusCard?.code).toBe("RECOVERY_CONNECTED");
    expect(connectSerialPort).toHaveBeenCalledTimes(2);
  });

  it("manual selection cancels recovery and keeps manual action ownership", async () => {
    vi.useFakeTimers();

    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
          {
            name: "COM7",
            kind: "unknown",
            isSupported: false,
            supportReason: "Other",
            usb: null,
          },
        ]),
      )
      .mockResolvedValueOnce(listResponse([]));

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      runSerialHealthCheck: vi.fn().mockResolvedValue(createHealthPass()),
      refreshMinIntervalMs: 0,
      recoveryFastDelayMs: 10,
      recoveryRetryDelayMs: 20,
      recoveryMaxAttempts: 3,
    });

    await controller.initialize();
    await controller.connectSelectedPort();
    const refreshPromise = controller.refreshPorts();
    await vi.advanceTimersByTimeAsync(600);
    await refreshPromise;
    controller.selectPort("COM7");

    expect(controller.getState().isReconnecting).toBe(false);
    expect(controller.getState().activeOperation).toBe("idle");
    expect(controller.getState().selectedPort).toBe("COM7");
    expect(controller.getState().statusCard?.code).toBe("RECOVERY_CANCELLED_BY_USER");
  });

  it("rejects health check while recovery is active", async () => {
    vi.useFakeTimers();

    const runSerialHealthCheck = vi.fn().mockResolvedValue(createHealthPass());
    const listSerialPorts = vi
      .fn<() => Promise<SerialPortListResponse>>()
      .mockResolvedValueOnce(
        listResponse([
          {
            name: "COM3",
            kind: "usb",
            isSupported: true,
            supportReason: "Supported USB serial adapter",
            usb: { vid: 0x1a86, pid: 0x7523, manufacturer: null, product: null, serialNumber: null },
          },
        ]),
      )
      .mockResolvedValueOnce(listResponse([]));

    const controller = createDeviceConnectionController({
      listSerialPorts,
      connectSerialPort: vi.fn().mockResolvedValue({
        connected: true,
        portName: "COM3",
        updatedAtUnixMs: Date.now(),
        status: { code: "CONNECT_OK", message: "Connected", details: null },
      }),
      getSerialConnectionStatus: vi.fn(),
      persistLastSuccessfulPort: vi.fn(),
      runSerialHealthCheck,
      refreshMinIntervalMs: 0,
      recoveryFastDelayMs: 100,
      recoveryRetryDelayMs: 100,
      recoveryMaxAttempts: 2,
    });

    await controller.initialize();
    await controller.connectSelectedPort();
    const refreshPromise = controller.refreshPorts();
    await vi.advanceTimersByTimeAsync(600);
    await refreshPromise;
    await controller.runHealthCheck();

    expect(controller.getState().isReconnecting).toBe(true);
    expect(runSerialHealthCheck).not.toHaveBeenCalled();
  });
});
