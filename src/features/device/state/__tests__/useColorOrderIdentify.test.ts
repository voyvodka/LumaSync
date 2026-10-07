import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedColorOrder } from "@/shared/contracts/device";
import { LED_TEST_STATUS, type LedTestPatternResult, type LedTestStatusCode } from "@/shared/contracts/preview";

import { colorOrderFromAnswers, useColorOrderIdentify } from "../useColorOrderIdentify";

const result = (code: LedTestStatusCode, active: boolean, previewOnly = false): LedTestPatternResult => ({
  active,
  previewOnly,
  status: { code, message: "", details: null },
});
const STARTED = result(LED_TEST_STATUS.PATTERN_STARTED, true);
const STOPPED = result(LED_TEST_STATUS.PATTERN_STOPPED, false);
const STOP_FAILED = result(LED_TEST_STATUS.PATTERN_RUNTIME_ERROR, true);

function setup(start: () => Promise<LedTestPatternResult>, stop: () => Promise<LedTestPatternResult> = async () => STOPPED) {
  const deps = {
    start: vi.fn(start),
    stop: vi.fn(stop),
    save: vi.fn<(order: LedColorOrder) => Promise<void>>(async () => {}),
    onApplied: vi.fn<(order: LedColorOrder) => void>(),
    current: "rgb" as LedColorOrder,
  };
  const hook = renderHook(() => useColorOrderIdentify(deps));
  return { deps, hook };
}

async function answerAll(hook: ReturnType<typeof setup>["hook"], answers: ("r" | "g" | "b")[]) {
  for (const given of answers) await act(async () => hook.result.current.answer(given));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("colorOrderFromAnswers", () => {
  it("spells the order from three distinct answers, and nothing else", () => {
    expect(colorOrderFromAnswers(["g", "r", "b"])).toBe("grb");
    expect(colorOrderFromAnswers(["r", "r", "b"])).toBeNull();
    expect(colorOrderFromAnswers(["r", "g"])).toBeNull();
  });
});

describe("useColorOrderIdentify", () => {
  it.each([
    ["the probe only reached the preview", result(LED_TEST_STATUS.PATTERN_PREVIEW_ONLY, true, true), "notSending"],
    ["a start that says preview-only", result(LED_TEST_STATUS.PATTERN_STARTED, true, true), "notSending"],
    ["the strip has no layout", result(LED_TEST_STATUS.PATTERN_NO_CALIBRATION, false), "noCalibration"],
    ["the start failed", result(LED_TEST_STATUS.PATTERN_RUNTIME_ERROR, false), "startFailed"],
  ])("fails when %s, and stops only a probe that is lit", async (_, started, reason) => {
    const { deps, hook } = setup(async () => started);
    await act(async () => hook.result.current.begin());
    expect(hook.result.current.state).toEqual({ step: "failed", reason });
    expect(deps.stop).toHaveBeenCalledTimes(started.active ? 1 : 0);
  });

  it("a start that throws fails as a start that failed", async () => {
    const { hook } = setup(async () => {
      throw new Error("ipc");
    });
    await act(async () => hook.result.current.begin());
    expect(hook.result.current.state).toEqual({ step: "failed", reason: "startFailed" });
  });

  // Saved already: a retry saves again (the same order) and tries the stop once more.
  it("when the stop cannot be confirmed, keeps the order and retries it without retuning meanwhile", async () => {
    let stopResult = STOP_FAILED;
    const { deps, hook } = setup(async () => STARTED, async () => stopResult);
    await act(async () => hook.result.current.begin());
    await answerAll(hook, ["g", "r", "b"]);
    expect(hook.result.current.state).toEqual({ step: "result", order: "grb", pending: false });

    await act(async () => hook.result.current.apply());
    expect(hook.result.current.state).toEqual({ step: "failed", reason: "stopFailed", order: "grb" });
    expect(deps.onApplied).not.toHaveBeenCalled();

    stopResult = STOPPED;
    await act(async () => hook.result.current.apply());
    expect(deps.save).toHaveBeenCalledTimes(2);
    expect(deps.onApplied).toHaveBeenCalledWith("grb");
    expect(hook.result.current.state).toEqual({ step: "verify", order: "grb", previous: "rgb", pending: false });
  });

  it("a failed save stops the probe and says so", async () => {
    const { deps, hook } = setup(async () => STARTED);
    deps.save.mockRejectedValueOnce(new Error("disk"));
    await act(async () => hook.result.current.begin());
    await answerAll(hook, ["b", "g", "r"]);
    await act(async () => hook.result.current.apply());
    expect(hook.result.current.state).toEqual({ step: "failed", reason: "saveFailed" });
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.onApplied).not.toHaveBeenCalled();
  });

  it("leaving mid-flow stops the lit probe", async () => {
    const { deps, hook } = setup(async () => STARTED);
    await act(async () => hook.result.current.begin());
    await act(async () => hook.unmount());
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it("Keep ends the flow with the new order in place", async () => {
    const { deps, hook } = setup(async () => STARTED);
    await act(async () => hook.result.current.begin());
    await answerAll(hook, ["r", "b", "g"]);
    await act(async () => hook.result.current.apply());
    await act(async () => hook.result.current.keep());
    expect(hook.result.current.state).toEqual({ step: "idle" });
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith("rbg");
  });
});
