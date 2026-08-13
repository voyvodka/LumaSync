// Both terms must be met before a poll loop gives up, so no cadence can turn a
// Wi-Fi hiccup into a missing bridge. See docs/architecture/hue.md.
export const HUE_POLL_GIVE_UP_AFTER_FAILURES = 4;
export const HUE_POLL_GIVE_UP_AFTER_MS = 90_000;

export interface PollFailureVerdict {
  /** Consecutive failures including this one. */
  streak: number;
  /** Whether the loop should stop scheduling and surface a manual retry. */
  exhausted: boolean;
}

export interface PollBudget {
  /** The bridge answered — the streak is over, whatever the answer said. */
  recordSuccess(): void;
  recordFailure(): PollFailureVerdict;
}

export interface PollBudgetOptions {
  maxFailures?: number;
  minStreakMs?: number;
  now?: () => number;
}

export function createPollBudget(options: PollBudgetOptions = {}): PollBudget {
  const maxFailures = options.maxFailures ?? HUE_POLL_GIVE_UP_AFTER_FAILURES;
  const minStreakMs = options.minStreakMs ?? HUE_POLL_GIVE_UP_AFTER_MS;
  const now = options.now ?? Date.now;

  let streak = 0;
  let streakStartedAt = 0;

  return {
    recordSuccess() {
      streak = 0;
      streakStartedAt = 0;
    },
    recordFailure() {
      const at = now();
      if (streak === 0) streakStartedAt = at;
      streak += 1;
      return {
        streak,
        exhausted: streak >= maxFailures && at - streakStartedAt >= minStreakMs,
      };
    },
  };
}
