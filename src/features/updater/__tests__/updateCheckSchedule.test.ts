import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createUpdateCheckScheduler,
  nextCheckDelayMs,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_RETRY_DELAYS_MS,
  UPDATE_CHECK_TICK_MS,
} from "../updateCheckSchedule";
import type { BackgroundCheckOutcome } from "../useAutoUpdater";

const MINUTE = 60_000;

describe("nextCheckDelayMs", () => {
  it("waits a day after an answered check and stops when checks are off", () => {
    expect(nextCheckDelayMs("done", 0)).toBe(UPDATE_CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs("off", 0)).toBeNull();
  });

  it("backs off after failures, then falls back to the daily check", () => {
    expect([1, 2, 3, 4].map((n) => nextCheckDelayMs("failed", n))).toEqual([
      MINUTE,
      5 * MINUTE,
      15 * MINUTE,
      UPDATE_CHECK_INTERVAL_MS,
    ]);
  });
});

describe("createUpdateCheckScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(outcomes: BackgroundCheckOutcome[]) {
    const check = vi.fn(() => Promise.resolve(outcomes.shift() ?? "done"));
    return { check, schedule: createUpdateCheckScheduler(check) };
  }

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("checks at start, then once a day", async () => {
    const { check, schedule } = scheduler([]);
    schedule.start();
    await advance(0);
    expect(check).toHaveBeenCalledTimes(1);

    await advance(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  // "LumaSync tries again next launch" was the whole retry story.
  it("retries a failed launch check at 1, 5 and 15 minutes, then daily", async () => {
    const { check, schedule } = scheduler(["failed", "failed", "failed", "failed"]);
    schedule.start();
    await advance(0);
    for (const [index, delay] of UPDATE_CHECK_RETRY_DELAYS_MS.entries()) {
      await advance(delay);
      expect(check).toHaveBeenCalledTimes(index + 2);
    }
    await advance(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(check).toHaveBeenCalledTimes(4);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it("goes back to the daily interval once a retry succeeds", async () => {
    const { check, schedule } = scheduler(["failed", "done"]);
    schedule.start();
    await advance(0);
    await advance(MINUTE);
    expect(check).toHaveBeenCalledTimes(2);
    await advance(5 * MINUTE);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stops for good when checks are off (the e2e build)", async () => {
    const { check, schedule } = scheduler(["off"]);
    schedule.start();
    await advance(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind once stopped", async () => {
    const { check, schedule } = scheduler([]);
    schedule.start();
    await advance(0);
    schedule.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advance(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  // StrictMode mounts, unmounts and mounts again: that must not check twice.
  it("resumes the same chain on a restart instead of checking again", async () => {
    const { check, schedule } = scheduler([]);
    schedule.start();
    schedule.stop();
    schedule.start();
    await advance(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("never runs two checks at once", async () => {
    let finish!: (outcome: BackgroundCheckOutcome) => void;
    const check = vi.fn(
      () =>
        new Promise<BackgroundCheckOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const schedule = createUpdateCheckScheduler(check);
    schedule.start();
    schedule.stop();
    schedule.start();
    await advance(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(check).toHaveBeenCalledTimes(1);

    finish("done");
    await advance(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  // A pending timeout does not always advance while the machine sleeps; the
  // deadline is wall-clock, and the timer only ever waits an hour at most.
  it("keeps its timer short and judges the deadline by the clock", async () => {
    const { schedule } = scheduler([]);
    schedule.start();
    await advance(0);
    const delays: number[] = [];
    const spy = vi.spyOn(window, "setTimeout");
    await advance(UPDATE_CHECK_TICK_MS);
    for (const call of spy.mock.calls) delays.push(Number(call[1]));
    expect(Math.max(...delays)).toBeLessThanOrEqual(UPDATE_CHECK_TICK_MS);
  });

  it("logs and retries when the check itself throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const check = vi.fn<() => Promise<BackgroundCheckOutcome>>().mockRejectedValueOnce(new Error("boom"));
    check.mockResolvedValue("done");
    const schedule = createUpdateCheckScheduler(check);
    schedule.start();
    await advance(0);
    expect(error).toHaveBeenCalledWith("[LumaSync] background update check threw:", expect.any(Error));
    await advance(MINUTE);
    expect(check).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
