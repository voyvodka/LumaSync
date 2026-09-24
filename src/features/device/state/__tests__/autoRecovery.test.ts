import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_OPERATION, DEVICE_STATUS } from "@/shared/contracts/device";
import type { SerialConnectionStatus, SerialPortListResponse } from "../../deviceConnectionApi";
import { createAutoRecovery } from "../autoRecovery";
import { createConnectionStore } from "../connectionStore";
import { DEFAULT_STATE } from "../connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "../connectionTypes";

function emptyPorts(): SerialPortListResponse {
  return { status: { code: "LIST_PORTS_OK", message: "ok", details: null }, ports: [] };
}

function baseDeps(overrides: Partial<DeviceConnectionControllerDeps> = {}): DeviceConnectionControllerDeps {
  return {
    listSerialPorts: vi.fn<() => Promise<SerialPortListResponse>>().mockResolvedValue(emptyPorts()),
    connectSerialPort: vi.fn<() => Promise<SerialConnectionStatus>>(),
    getSerialConnectionStatus: vi.fn<DeviceConnectionControllerDeps["getSerialConnectionStatus"]>(),
    persistLastSuccessfulPort: vi.fn<DeviceConnectionControllerDeps["persistLastSuccessfulPort"]>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const timing = { recoveryFastDelayMs: 10, recoveryRetryDelayMs: 20, recoveryMaxAttempts: 2 };

describe("createAutoRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up and requires manual reconnect once every retry attempt finds the port missing", async () => {
    const deps = baseDeps();
    const store = createConnectionStore(DEFAULT_STATE);
    const recovery = createAutoRecovery(store, deps, timing, null);

    recovery.startAutoRecovery("COM3");
    expect(store.getState().status).toBe(DEVICE_STATUS.RECONNECTING);

    // fast delay (10ms, attempt 1) + retry delay (20ms, attempt 2) exhausts
    // `recoveryMaxAttempts: 2`.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(store.getState().status).toBe(DEVICE_STATUS.MANUAL_REQUIRED);
    expect(store.getState().statusCard?.code).toBe("RECOVERY_MANUAL_REQUIRED");
    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.IDLE);
    expect(store.getState().isReconnecting).toBe(false);

    // The gate must be released: no further retry timer should still be armed.
    const callsAtGiveUp = (deps.listSerialPorts as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.listSerialPorts).toHaveBeenCalledTimes(callsAtGiveUp);
  });

  it("leaves a foreign operation's slot untouched when cancelRecovery is called after it has moved on", async () => {
    const deps = baseDeps();
    const store = createConnectionStore(DEFAULT_STATE);
    const recovery = createAutoRecovery(store, deps, timing, null);

    recovery.startAutoRecovery("COM3");
    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.RECOVERY);

    // Simulate a health check that has since taken over the operation slot —
    // the store is the single source of truth `cancelRecovery` reads from,
    // so mutating it directly is the honest way to reproduce the race the
    // ownership guard exists for.
    store.setState((prev) => ({
      ...prev,
      activeOperation: DEVICE_OPERATION.HEALTH_CHECK,
      isHealthChecking: true,
      isReconnecting: false,
    }));

    recovery.cancelRecovery();

    // A blind `activeOperation: IDLE` write here would tell the store no
    // operation is running while the health check is still in flight,
    // letting a second operation start concurrently underneath it.
    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.HEALTH_CHECK);
    expect(store.getState().isHealthChecking).toBe(true);

    // The pending recovery timer must still be cleared regardless.
    const callsAtCancel = (deps.listSerialPorts as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.listSerialPorts).toHaveBeenCalledTimes(callsAtCancel);
  });
});
