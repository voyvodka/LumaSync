import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import {
  isHueSessionReconnecting,
  isHueStreamDead,
  isHueStreamFailed,
  useHueStreamHealth,
} from "../useHueStreamHealth";
import {
  fakeHueHealthApi,
  publishHealth,
  resetHealth,
  runtimeStatus,
  setHealth,
} from "../../__tests__/fakeHueHealth";

vi.mock("../../hueHealthApi", async () => (await import("../../__tests__/fakeHueHealth")).fakeHueHealthApi);

const stream = (state: "Running" | "Reconnecting" | "Failed" | "Idle") => ({
  stream: { active: state === "Running" || state === "Reconnecting", status: runtimeStatus(state) },
});

function mount(opts: { hueTargetSelected?: boolean } = {}) {
  return renderHook(() => useHueStreamHealth({ hueTargetSelected: opts.hueTargetSelected ?? true }));
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const publish = async (state: "Running" | "Reconnecting" | "Failed" | "Idle") => {
  act(() => {
    publishHealth(stream(state));
  });
  await flush();
};

describe("useHueStreamHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Read-only since the transaction: the worker follows the live stream slot
  // through every reconnect, so a stream that comes back is re-applied by
  // nobody.
  it("follows a stream dying and coming back from what Rust publishes", async () => {
    setHealth(stream("Failed"));
    const view = mount();
    await flush();
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(true);

    await publish("Running");
    expect(view.result.current.runtimeState).toBe("Running");
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(false);
  });

  it("reports nothing while Hue is not a selected output", async () => {
    setHealth(stream("Running"));
    const view = mount({ hueTargetSelected: false });
    await flush();

    expect(view.result.current.runtimeState).toBeNull();
  });

  // A bridge unreachable for hours stays RECONNECTING with "hue" still in the
  // active targets, so the shell read membership as STREAMING the whole time.
  it("reports RECONNECTING so the shell can stop calling the session live", async () => {
    setHealth(stream("Reconnecting"));
    const view = mount();
    await flush();

    // The backend is still retrying, so a reconnecting stream is not dead…
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(false);
    // …but the state it reports is what the UI must show.
    expect(view.result.current.runtimeState).toBe("Reconnecting");
    expect(isHueSessionReconnecting(true, view.result.current.runtimeState)).toBe(true);

    await publish("Running");
    expect(view.result.current.runtimeState).toBe("Running");
  });

  // The shell shows FAILED from this reading. It used to hold until a 15 s
  // dead-stream poll noticed the restart; Rust now publishes the restart itself.
  it("drops a held Failed the moment the start or stop that ended it is published", async () => {
    setHealth(stream("Failed"));
    const view = mount();
    await flush();
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(true);

    await publish("Idle");
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(false);
  });

  it("only calls an owned session reconnecting", () => {
    expect(isHueSessionReconnecting(false, "Reconnecting")).toBe(false);
    expect(isHueSessionReconnecting(true, "Running")).toBe(false);
    expect(isHueSessionReconnecting(true, null)).toBe(false);
  });

  it("never asks for the stream on a timer", async () => {
    mount();
    await flush(120_000);

    expect(fakeHueHealthApi.getHueHealth).not.toHaveBeenCalled();
    expect(fakeHueHealthApi.watchHueHealth).toHaveBeenCalledOnce();
  });
});
