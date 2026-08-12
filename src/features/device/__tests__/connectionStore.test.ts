import { describe, expect, it } from "vitest";

import { DEVICE_OPERATION } from "@/shared/contracts/device";
import { DEFAULT_STATE } from "../state/connectionStateHelpers";
import { createConnectionStore } from "../state/connectionStore";

describe("connectionStore operation gate", () => {
  it("issues a token and blocks a second concurrent operation", () => {
    const store = createConnectionStore(DEFAULT_STATE);

    const first = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);
    const second = store.beginOperation(DEVICE_OPERATION.HEALTH_CHECK);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.MANUAL_CONNECT);
  });

  it("returns to IDLE once the current token finishes, and allows a new operation after", () => {
    const store = createConnectionStore(DEFAULT_STATE);
    const token = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);

    store.finishOperation(token as number);

    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.IDLE);
    expect(store.beginOperation(DEVICE_OPERATION.HEALTH_CHECK)).not.toBeNull();
  });

  it("no-ops finishOperation on a stale token", () => {
    const store = createConnectionStore(DEFAULT_STATE);
    const staleToken = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT) as number;
    store.finishOperation(staleToken);
    store.beginOperation(DEVICE_OPERATION.HEALTH_CHECK);

    store.finishOperation(staleToken);

    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.HEALTH_CHECK);
  });

  it("invalidateCurrentOperation orphans the in-flight token without touching activeOperation", () => {
    const store = createConnectionStore(DEFAULT_STATE);
    const token = store.beginOperation(DEVICE_OPERATION.RECOVERY) as number;

    store.invalidateCurrentOperation();

    expect(store.isCurrentToken(token)).toBe(false);
    expect(store.getState().activeOperation).toBe(DEVICE_OPERATION.RECOVERY);
  });

  it("stops notifying listeners and reports disposed after dispose()", () => {
    const store = createConnectionStore(DEFAULT_STATE);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.dispose();
    store.setState((prev) => ({ ...prev, isScanning: true }));

    expect(store.isDisposed()).toBe(true);
    expect(notifications).toBe(0);
  });
});
