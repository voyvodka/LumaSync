import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_IDENTIFY_SIGNAL_MS, HUE_IDENTIFY_STATUS, type HueIdentifyStatus } from "@/shared/contracts/hue";

import { useHueIdentify } from "../useHueIdentify";

const mockIdentify = vi.hoisted(() => vi.fn<(ip: string, key: string, ids: string[]) => Promise<HueIdentifyStatus>>());

vi.mock("@/features/hue/hueOnboardingApi", () => ({
  identifyHueLights: (ip: string, key: string, ids: string[]) => mockIdentify(ip, key, ids),
}));

const status = (code: string): HueIdentifyStatus => ({ code, message: "m" }) as HueIdentifyStatus;

beforeEach(() => {
  vi.useFakeTimers();
  mockIdentify.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useHueIdentify", () => {
  it("asks the bridge with no key of its own and stays busy while the lights blink", async () => {
    mockIdentify.mockResolvedValue(status(HUE_IDENTIFY_STATUS.OK));
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"));

    await act(async () => result.current.identify("hue-0", ["l-a"]));
    expect(mockIdentify).toHaveBeenCalledWith("192.168.1.2", "", ["l-a"]);
    expect(result.current.busyId).toBe("hue-0");

    await act(async () => vi.advanceTimersByTime(HUE_IDENTIFY_SIGNAL_MS));
    expect(result.current.busyId).toBeNull();
    expect(result.current.failure).toBeNull();
  });

  it("takes one light at a time", async () => {
    mockIdentify.mockResolvedValue(status(HUE_IDENTIFY_STATUS.OK));
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => result.current.identify("hue-0", ["l-a"]));
    await act(async () => result.current.identify("hue-1", ["l-b"]));
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a bridge or lights", async () => {
    const none = renderHook(() => useHueIdentify(null));
    await act(async () => none.result.current.identify("hue-0", ["l-a"]));
    const empty = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => empty.result.current.identify("hue-0", []));
    expect(mockIdentify).not.toHaveBeenCalled();
  });

  it("says why it failed, logs it, and frees the button soon", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockIdentify.mockResolvedValue(status(HUE_IDENTIFY_STATUS.BLOCKED_STREAMING));
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => result.current.identify("hue-0", ["l-a"]));
    expect(result.current.failure).toEqual({ id: "hue-0", code: HUE_IDENTIFY_STATUS.BLOCKED_STREAMING });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Hue identify failed"));
    await act(async () => vi.advanceTimersByTime(600));
    expect(result.current.busyId).toBeNull();
    warn.mockRestore();
  });

  it("treats a rejected command as a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockIdentify.mockRejectedValue(new Error("ipc"));
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => result.current.identify("hue-0", ["l-a"]));
    expect(result.current.failure?.code).toBe(HUE_IDENTIFY_STATUS.FAILED);
    warn.mockRestore();
  });

  it("frees the button after a StrictMode remount, as a dev build mounts it", async () => {
    mockIdentify.mockResolvedValue(status(HUE_IDENTIFY_STATUS.OK));
    // The StrictMode element alone does not replay effects here; the library's own switch does.
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"), { reactStrictMode: true });
    await act(async () => result.current.identify("hue-0", ["l-a"]));
    await act(async () => vi.advanceTimersByTime(HUE_IDENTIFY_SIGNAL_MS));
    expect(result.current.busyId).toBeNull();
  });

  it("says some lights did not blink, and still holds for the blink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockIdentify.mockResolvedValue(status(HUE_IDENTIFY_STATUS.PARTIAL));
    const { result } = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => result.current.identify("hue-0", ["l-a", "l-b"]));
    expect(result.current.failure?.code).toBe(HUE_IDENTIFY_STATUS.PARTIAL);
    await act(async () => vi.advanceTimersByTime(600));
    expect(result.current.busyId).toBe("hue-0");
    warn.mockRestore();
  });

  it("leaves nothing running when the card closes before the bridge answers", async () => {
    let answer: (status: HueIdentifyStatus) => void = () => {};
    mockIdentify.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useHueIdentify("192.168.1.2"));
    await act(async () => result.current.identify("hue-0", ["l-a"]));
    unmount();
    await act(async () => answer(status(HUE_IDENTIFY_STATUS.OK)));
    expect(vi.getTimerCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
