import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import {
  __resetHueTestLease,
  acquireHueForTest,
  releaseHueAfterTest,
  type HueTestLeaseDeps,
} from "../hueTestLease";

const PAIRED_STATE = {
  lastHueBridge: { ip: "192.168.1.10" },
  hueAppKey: "app-key",
  hueClientKey: "client-key",
  lastHueAreaId: "area-1",
};

function makeDeps(overrides: {
  state?: Record<string, unknown>;
  startCode?: string;
  runningMode?: Record<string, unknown>;
} = {}) {
  const load = vi.fn().mockResolvedValue(overrides.state ?? PAIRED_STATE);
  const start = vi.fn().mockResolvedValue({
    status: { code: overrides.startCode ?? HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS, message: "" },
  });
  const stop = vi.fn().mockResolvedValue({
    status: { code: HUE_RUNTIME_STATUS.STREAM_STOPPED, message: "" },
  });
  const readMode = vi.fn().mockResolvedValue({
    active: overrides.runningMode !== undefined,
    mode: overrides.runningMode ?? { kind: "off" },
    status: { code: "LIGHTING_MODE_STATUS_OK", message: "" },
  });
  return { load, start, stop, readMode } as unknown as HueTestLeaseDeps & {
    load: typeof load;
    start: typeof start;
    stop: typeof stop;
    readMode: typeof readMode;
  };
}

describe("hueTestLease", () => {
  beforeEach(() => {
    __resetHueTestLease();
    vi.restoreAllMocks();
  });

  it("does not touch the bridge when the run does not target hue", async () => {
    const deps = makeDeps();
    await acquireHueForTest(["usb"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("starts the stream once across the repeated starts a live pattern issues", async () => {
    const deps = makeDeps();
    await acquireHueForTest(["usb", "hue"], deps);
    await acquireHueForTest(["usb", "hue"], deps);
    await acquireHueForTest(["usb", "hue"], deps);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.start).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.10",
      username: "app-key",
      clientKey: "client-key",
      areaId: "area-1",
    });
  });

  it("stops only the stream it opened", async () => {
    const deps = makeDeps();
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  // A mode started during the run took over the stream the lease opened; its
  // worker holds the sender, so a stop here would land under it.
  it("hands the stream to a running mode that names Hue instead of stopping it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const deps = makeDeps({ runningMode: { kind: "ambilight", targets: ["usb", "hue"] } });
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.readMode).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("still stops when the running mode does not name Hue", async () => {
    const deps = makeDeps({ runningMode: { kind: "solid", targets: ["usb"] } });
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it("stops as before when the running mode cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    deps.readMode.mockRejectedValue(new Error("LIGHTING_RUNTIME_STATE_LOCK_FAILED"));
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it("leaves a stream someone else already owns alone", async () => {
    const deps = makeDeps({ startCode: HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE });
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("stops nothing when the bridge refuses the start", async () => {
    const deps = makeDeps({ startCode: HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("never contacts the bridge when no pairing is stored", async () => {
    const deps = makeDeps({ state: {} });
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    expect(deps.start).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it("re-acquires on the next run after a release", async () => {
    const deps = makeDeps();
    await acquireHueForTest(["hue"], deps);
    await releaseHueAfterTest(deps);
    await acquireHueForTest(["hue"], deps);
    expect(deps.start).toHaveBeenCalledTimes(2);
  });

  it("does not let a release overtake an acquire still in flight", async () => {
    const order: string[] = [];
    const deps = makeDeps();
    (deps.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("start");
      return { status: { code: HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS, message: "" } };
    });
    (deps.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("stop");
      return { status: { code: HUE_RUNTIME_STATUS.STREAM_STOPPED, message: "" } };
    });

    const acquiring = acquireHueForTest(["hue"], deps);
    const releasing = releaseHueAfterTest(deps);
    await Promise.all([acquiring, releasing]);

    expect(order).toEqual(["start", "stop"]);
  });
});
