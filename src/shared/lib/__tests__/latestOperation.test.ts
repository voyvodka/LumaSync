import { describe, expect, it } from "vitest";

import { createLatestOperationGuard } from "../latestOperation";

describe("createLatestOperationGuard", () => {
  it("keeps a single run authoritative", () => {
    const guard = createLatestOperationGuard();
    const isLatest = guard.begin();

    expect(isLatest()).toBe(true);
    expect(isLatest()).toBe(true);
  });

  it("demotes an earlier run as soon as a later one begins", () => {
    const guard = createLatestOperationGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("only the newest of many survives, whatever order they resolve in", () => {
    const guard = createLatestOperationGuard();
    const runs = [guard.begin(), guard.begin(), guard.begin()];

    expect(runs.map((isLatest) => isLatest())).toEqual([false, false, true]);
  });

  it("guards are independent, so one surface cannot demote another", () => {
    const a = createLatestOperationGuard();
    const b = createLatestOperationGuard();
    const runA = a.begin();
    b.begin();

    expect(runA()).toBe(true);
  });
});
