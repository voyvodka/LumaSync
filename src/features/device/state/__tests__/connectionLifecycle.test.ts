import { describe, expect, it, vi } from "vitest";

import { DEVICE_STATUS } from "@/shared/contracts/device";
import type { SerialConnectionStatus, SerialPortListResponse } from "../../deviceConnectionApi";
import { createConnectionLifecycle } from "../connectionLifecycle";
import { createConnectionStore } from "../connectionStore";
import { DEFAULT_STATE } from "../connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "../connectionTypes";

function baseDeps(overrides: Partial<DeviceConnectionControllerDeps> = {}): DeviceConnectionControllerDeps {
  return {
    listSerialPorts: vi.fn<() => Promise<SerialPortListResponse>>(),
    connectSerialPort: vi.fn<() => Promise<SerialConnectionStatus>>(),
    getSerialConnectionStatus: vi.fn(),
    persistLastSuccessfulPort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createConnectionLifecycle", () => {
  it("clears a stale SELECTED_PORT_MISSING card the moment the user picks a port themselves", () => {
    const deps = baseDeps();
    const store = createConnectionStore({
      ...DEFAULT_STATE,
      statusCard: {
        variant: "info",
        code: "SELECTED_PORT_MISSING",
        message: "Previously selected port is no longer visible.",
      },
    });
    const lifecycle = createConnectionLifecycle(store, deps, null, { cancelRecovery: vi.fn() });

    lifecycle.selectPort("COM5");

    // A stale "your port vanished" bubble must not survive the user acting
    // on it — leaving it behind reads as if the fresh pick failed too.
    expect(store.getState().statusCard).toBeNull();
    expect(store.getState().selectedPort).toBe("COM5");
  });

  it("leaves an unrelated status card alone when the user picks a port", () => {
    const deps = baseDeps();
    const store = createConnectionStore({
      ...DEFAULT_STATE,
      statusCard: { variant: "error", code: "CONNECT_FAILED", message: "Could not connect." },
    });
    const lifecycle = createConnectionLifecycle(store, deps, null, { cancelRecovery: vi.fn() });

    lifecycle.selectPort("COM5");

    expect(store.getState().statusCard?.code).toBe("CONNECT_FAILED");
  });

  it("ignores connectSelectedPort while a scan, connect, or health check is already running", async () => {
    const connectSerialPort = vi.fn<() => Promise<SerialConnectionStatus>>();
    const deps = baseDeps({ connectSerialPort });
    const store = createConnectionStore({
      ...DEFAULT_STATE,
      selectedPort: "COM3",
      isHealthChecking: true,
    });
    const lifecycle = createConnectionLifecycle(store, deps, null, { cancelRecovery: vi.fn() });

    await lifecycle.connectSelectedPort();

    // `beginOperation` would have refused the gate anyway, but this guard is
    // what stops a redundant `connectSerialPort` round-trip from firing
    // while a health check already owns the port.
    expect(connectSerialPort).not.toHaveBeenCalled();
    expect(store.getState().status).not.toBe(DEVICE_STATUS.CONNECTING);
  });
});
