import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HueStreamReadinessResponse } from "@/features/hue/hueOnboardingApi";
import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import { HUE_READINESS_REASON, HUE_STATUS } from "@/shared/contracts/hue";

const checkReadinessMock = vi.fn();
vi.mock("@/features/hue/hueOnboardingApi", () => ({
  checkHueStreamReadiness: (...args: unknown[]) => checkReadinessMock(...args),
}));

import type { LightingModeConfig } from "../../model/contracts";
import { stopHue } from "../../modeApi";
import {
  BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS,
  BOOT_HUE_RETRY_POLL_MS,
  BOOT_HUE_RETRY_WINDOW_MS,
  isHueBusyCandidate,
  readHueAreaVerdict,
  useBootHueRetry,
  waitForHueAreaRelease,
} from "../bootHueRetry";

function readiness(code: string, ready: boolean, reasons: string[]): HueStreamReadinessResponse {
  return {
    status: { code, message: code, details: null },
    readiness: { ready, reasons },
  } as HueStreamReadinessResponse;
}

const BUSY = readiness(HUE_STATUS.STREAM_NOT_READY, false, [HUE_READINESS_REASON.ACTIVE_STREAMER]);
const FREE = readiness(HUE_STATUS.STREAM_READY, true, []);

describe("isHueBusyCandidate", () => {
  it("accepts only the readiness gate's refusal", () => {
    expect(isHueBusyCandidate("CONFIG_NOT_READY_GATE_BLOCKED")).toBe(true);
    for (const code of [
      "AUTH_INVALID_CREDENTIALS",
      "AUTH_INVALID_RE_PAIR_REQUIRED",
      "TRANSIENT_RETRY_SCHEDULED",
      "HUE_STREAM_RUNNING",
      undefined,
    ]) {
      expect(isHueBusyCandidate(code)).toBe(false);
    }
  });
});

describe("readHueAreaVerdict", () => {
  it("reads a lone active-streamer reason as busy", () => {
    expect(readHueAreaVerdict(BUSY)).toBe("busy");
  });

  it("reads a ready area as free", () => {
    expect(readHueAreaVerdict(FREE)).toBe("free");
  });

  // Freeing the streamer would not make this area start.
  it("does not call an area busy when another reason blocks it too", () => {
    expect(
      readHueAreaVerdict(
        readiness(HUE_STATUS.STREAM_NOT_READY, false, [
          "Selected area has no entertainment channels configured.",
          HUE_READINESS_REASON.ACTIVE_STREAMER,
        ]),
      ),
    ).toBe("other");
  });

  it.each([
    [HUE_STATUS.STREAM_READINESS_FAILED, "Bridge unreachable"],
    ["AUTH_INVALID_RE_PAIR_REQUIRED", "Bridge credentials are invalid; re-pair required."],
    [HUE_STATUS.STREAM_NOT_READY, "Selected area is unavailable on current bridge state."],
  ])("reads %s as not busy", (code, reason) => {
    expect(readHueAreaVerdict(readiness(code, false, [reason]))).toBe("other");
  });
});

describe("waitForHueAreaRelease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function run(answers: Array<HueStreamReadinessResponse | Error>, signal = new AbortController().signal) {
    const probe = vi.fn(() => {
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    const onBusy = vi.fn();
    const outcome = waitForHueAreaRelease({ probe, signal, onBusy });
    return { probe, onBusy, outcome };
  }

  it("resolves free once the streamer lets go, and reports busy once", async () => {
    const { probe, onBusy, outcome } = run([BUSY, BUSY, FREE]);

    await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_POLL_MS * 2);

    await expect(outcome).resolves.toBe("free");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onBusy).toHaveBeenCalledTimes(1);
  });

  it("gives up once the window closes", async () => {
    const { probe, outcome } = run([BUSY]);

    await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_WINDOW_MS + BOOT_HUE_RETRY_POLL_MS);

    await expect(outcome).resolves.toBe("timeout");
    // One at once, then one per poll that still fits inside the window.
    expect(probe.mock.calls.length).toBe(Math.floor(BOOT_HUE_RETRY_WINDOW_MS / BOOT_HUE_RETRY_POLL_MS) + 1);
  });

  it("stops at once, without a busy notice, when the refusal is not a busy area", async () => {
    const { probe, onBusy, outcome } = run([
      readiness(HUE_STATUS.STREAM_READINESS_FAILED, false, ["Bridge unreachable"]),
    ]);

    await expect(outcome).resolves.toBe("notBusy");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onBusy).not.toHaveBeenCalled();
  });

  it("stops when the bridge goes away partway through the wait", async () => {
    const { outcome } = run([BUSY, new Error("invoke failed")]);

    await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_POLL_MS);

    await expect(outcome).resolves.toBe("notBusy");
  });

  it("resolves cancelled when aborted mid-wait, and probes no further", async () => {
    const controller = new AbortController();
    const { probe, outcome } = run([BUSY], controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_WINDOW_MS);

    await expect(outcome).resolves.toBe("cancelled");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("useBootHueRetry", () => {
  const config = { bridgeIp: "192.168.1.10", username: "u", clientKey: "k", areaId: "area-1" } as HueStartConfig;
  const ambilight = { kind: "ambilight" } as LightingModeConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    checkReadinessMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mount() {
    const resume = vi.fn(() => Promise.resolve());
    const view = renderHook(() => useBootHueRetry(resume));
    return { resume, view };
  }

  it("resumes the restored mode once, after the area frees", async () => {
    checkReadinessMock.mockResolvedValueOnce(BUSY).mockResolvedValue(FREE);
    const { resume, view } = mount();

    act(() => view.result.current.schedule(ambilight, config));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.notice).toBe("waiting");
    expect(checkReadinessMock).toHaveBeenCalledWith("192.168.1.10", "u", "area-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_POLL_MS);
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(ambilight);
    expect(view.result.current.notice).toBeNull();
  });

  // The precedent: `stop_hue_stream` cancels the backend's own reconnect retry.
  it("is cancelled by a Hue stop from any surface", async () => {
    checkReadinessMock.mockResolvedValue(BUSY);
    const { resume, view } = mount();
    act(() => view.result.current.schedule(ambilight, config));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.notice).toBe("waiting");

    const invoker = vi.fn(() => Promise.resolve({ active: false, status: { code: "HUE_STREAM_STOPPED" } }));
    await act(async () => {
      await stopHue(undefined, invoker as never);
    });
    expect(view.result.current.notice).toBeNull();

    checkReadinessMock.mockResolvedValue(FREE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_WINDOW_MS);
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("shows the gave-up notice for a while, then clears it", async () => {
    checkReadinessMock.mockResolvedValue(BUSY);
    const { resume, view } = mount();
    act(() => view.result.current.schedule(ambilight, config));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_WINDOW_MS);
    });
    expect(view.result.current.notice).toBe("gaveUp");
    expect(resume).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS);
    });
    expect(view.result.current.notice).toBeNull();
  });
});
