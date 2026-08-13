import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUE_POLL_GIVE_UP_AFTER_FAILURES,
  HUE_POLL_GIVE_UP_AFTER_MS,
  createPollBudget,
} from "../pollBudget";

describe("createPollBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a failure streak and reports it", () => {
    const budget = createPollBudget();
    expect(budget.recordFailure().streak).toBe(1);
    expect(budget.recordFailure().streak).toBe(2);
  });

  it("does not give up before both the count and the time floor are met", () => {
    const budget = createPollBudget();
    // Ten failures crammed into one second — a fast cadence must not be
    // mistaken for a long outage.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(100);
      expect(budget.recordFailure().exhausted).toBe(false);
    }
  });

  it("gives up once the streak is both long enough and old enough", () => {
    const budget = createPollBudget();
    let verdict = budget.recordFailure();
    for (let i = 1; i < HUE_POLL_GIVE_UP_AFTER_FAILURES; i += 1) {
      expect(verdict.exhausted).toBe(false);
      vi.advanceTimersByTime(HUE_POLL_GIVE_UP_AFTER_MS / (HUE_POLL_GIVE_UP_AFTER_FAILURES - 1));
      verdict = budget.recordFailure();
    }
    expect(verdict).toEqual({
      streak: HUE_POLL_GIVE_UP_AFTER_FAILURES,
      exhausted: true,
    });
  });

  it("a success in between resets the streak, so it does not give up early", () => {
    const budget = createPollBudget();
    budget.recordFailure();
    budget.recordFailure();
    vi.advanceTimersByTime(HUE_POLL_GIVE_UP_AFTER_MS);
    budget.recordSuccess();

    // Two more failures spanning the full time budget: four failures in
    // total, but only two consecutive — not a give-up.
    expect(budget.recordFailure().streak).toBe(1);
    vi.advanceTimersByTime(HUE_POLL_GIVE_UP_AFTER_MS);
    expect(budget.recordFailure()).toEqual({ streak: 2, exhausted: false });
  });

  it("keeps reporting exhausted once the budget is spent", () => {
    const budget = createPollBudget({ maxFailures: 2, minStreakMs: 10 });
    budget.recordFailure();
    vi.advanceTimersByTime(10);
    expect(budget.recordFailure().exhausted).toBe(true);
    expect(budget.recordFailure().exhausted).toBe(true);
  });
});
