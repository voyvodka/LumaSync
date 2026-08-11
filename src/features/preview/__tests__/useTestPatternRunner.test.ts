// useTestPatternRunner — the only thing standing between a 20 Hz colour drag
// and one ambilight-worker restart per commit.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LED_TEST_STATUS, type LedTestPatternResult } from "@/shared/contracts/preview";
import {
  isTestPatternErrorCode,
  useTestPatternRunner,
  type TestPatternRunRequest,
} from "../state/useTestPatternRunner";

type StartFn = (request: TestPatternRunRequest) => Promise<LedTestPatternResult>;

const MIN_INTERVAL = 250;

function ok(code: string = LED_TEST_STATUS.PATTERN_STARTED): LedTestPatternResult {
  return { active: true, previewOnly: false, status: { code: code as never, message: "" } };
}

function err(code: string = LED_TEST_STATUS.PATTERN_NO_CALIBRATION): LedTestPatternResult {
  return { active: false, previewOnly: false, status: { code: code as never, message: "" } };
}

function request(overrides: Partial<TestPatternRunRequest> = {}): TestPatternRunRequest {
  return { pattern: { kind: "gamut" }, brightness: 1, speed: "med", ...overrides };
}

function setup(start: ReturnType<typeof vi.fn<StartFn>>, stop = vi.fn(async () => ok())) {
  const onResult = vi.fn();
  const view = renderHook(() =>
    useTestPatternRunner({
      onResult,
      start: start as never,
      stop: stop as never,
      minIntervalMs: MIN_INTERVAL,
    }),
  );
  return { ...view, onResult, stop };
}

/** Flush the microtask queue so an awaited start settles inside `act`. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isTestPatternErrorCode", () => {
  it("treats PREVIEW_ONLY as a success, not an error", () => {
    expect(isTestPatternErrorCode(LED_TEST_STATUS.PATTERN_PREVIEW_ONLY)).toBe(false);
    expect(isTestPatternErrorCode(LED_TEST_STATUS.PATTERN_STARTED)).toBe(false);
    expect(isTestPatternErrorCode(LED_TEST_STATUS.PATTERN_NO_CALIBRATION)).toBe(true);
    expect(isTestPatternErrorCode(LED_TEST_STATUS.PATTERN_INVALID_PARAMS)).toBe(true);
    expect(isTestPatternErrorCode(LED_TEST_STATUS.PATTERN_RUNTIME_ERROR)).toBe(true);
  });
});

describe("useTestPatternRunner", () => {
  it("apply dispatches immediately and reports the result with its request", async () => {
    const start = vi.fn<StartFn>(async () => ok());
    const { result, onResult } = setup(start);
    const req = request({ pattern: { kind: "rainbow" } });

    act(() => result.current.apply(req));
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      pattern: { kind: "rainbow" },
      brightness: 1,
      speed: "med",
      targets: undefined,
    });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ active: true }), req);
  });

  it("throttles a burst of refreshes to one start per interval, keeping the newest", async () => {
    const start = vi.fn<StartFn>(async () => ok());
    const { result } = setup(start);

    // A colour drag: 10 commits at the 50 ms cadence of useSolidColorDraft.
    for (let i = 0; i < 10; i += 1) {
      act(() => result.current.refresh(request({ brightness: i / 10 })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }

    // 500 ms of dragging at 20 Hz would be 10 starts without the throttle.
    expect(start.mock.calls.length).toBeLessThanOrEqual(3);
    // Whatever landed carried a value from the drag, never a stale first frame
    // after the leading edge.
    const last = start.mock.calls[start.mock.calls.length - 1][0];
    expect(last.brightness).toBeGreaterThan(0);
  });

  it("never runs two starts concurrently and dispatches the queued newest on completion", async () => {
    let release: (() => void) | null = null;
    const start = vi.fn<StartFn>(
      () =>
        new Promise<LedTestPatternResult>((resolve) => {
          release = () => resolve(ok());
        }),
    );
    const { result } = setup(start);

    act(() => result.current.apply(request({ brightness: 0.1 })));
    await settle();
    expect(start).toHaveBeenCalledTimes(1);

    // Two more arrive while the first is still in flight.
    act(() => result.current.apply(request({ brightness: 0.2 })));
    act(() => result.current.apply(request({ brightness: 0.3 })));
    expect(start).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL);
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][0].brightness).toBe(0.3);
  });

  it("latches after a failed start so refreshes stop retrying in a loop", async () => {
    const start = vi.fn<StartFn>(async () => err());
    const { result, onResult } = setup(start);

    act(() => result.current.apply(request()));
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      act(() => result.current.refresh(request({ brightness: i / 10 })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MIN_INTERVAL + 10);
      });
    }

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a deliberate apply clears the latch and retries once", async () => {
    const start = vi.fn<StartFn>(async () => err());
    const { result } = setup(start);

    act(() => result.current.apply(request()));
    await settle();
    act(() => result.current.refresh(request({ brightness: 0.5 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL + 10);
    });
    expect(start).toHaveBeenCalledTimes(1);

    act(() => result.current.apply(request({ pattern: { kind: "spiral" } })));
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("cancel drops pending work and suppresses the in-flight result", async () => {
    let release: ((value: LedTestPatternResult) => void) | null = null;
    const start = vi.fn<StartFn>(
      () =>
        new Promise<LedTestPatternResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result, onResult } = setup(start);

    act(() => result.current.apply(request()));
    await settle();
    act(() => result.current.refresh(request({ brightness: 0.4 })));

    act(() => result.current.cancel());
    await act(async () => {
      release?.(ok());
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL * 2);
    });

    // The stale start neither writes run feedback nor re-dispatches.
    expect(onResult).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("settled resolves only once the in-flight start has landed", async () => {
    let release: ((value: LedTestPatternResult) => void) | null = null;
    const start = vi.fn<StartFn>(
      () =>
        new Promise<LedTestPatternResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup(start);

    act(() => result.current.apply(request()));
    await settle();

    let settledFlag = false;
    void result.current.settled().then(() => {
      settledFlag = true;
    });
    await settle();
    expect(settledFlag).toBe(false);

    await act(async () => {
      release?.(ok());
      await Promise.resolve();
    });
    await settle();
    expect(settledFlag).toBe(true);
  });

  it("stop drops the throttled refresh still waiting to fire", async () => {
    const start = vi.fn<StartFn>(async () => ok());
    const stop = vi.fn(async () => ok(LED_TEST_STATUS.PATTERN_STOPPED));
    const { result } = setup(start, stop);

    // First refresh takes the leading edge; the second is parked on the timer.
    act(() => result.current.refresh(request({ brightness: 0.1 })));
    await settle();
    act(() => result.current.refresh(request({ brightness: 0.2 })));
    expect(start).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.stop();
      await vi.advanceTimersByTimeAsync(MIN_INTERVAL * 2);
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a start that throws is logged and degraded to a coded runtime error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const start = vi
      .fn<StartFn>()
      .mockRejectedValueOnce(new Error("transport gone"))
      .mockResolvedValue(ok());
    const { result, onResult } = setup(start);

    act(() => result.current.apply(request()));
    await settle();

    expect(consoleError).toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ code: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR }),
      }),
      expect.anything(),
    );

    // The runner is not wedged — a later deliberate apply still dispatches.
    act(() => result.current.apply(request({ pattern: { kind: "spiral" } })));
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
