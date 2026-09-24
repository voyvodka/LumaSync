import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThrottledCommit } from "../useThrottledCommit";

describe("useThrottledCommit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const onCommit = vi.fn();
    const hook = renderHook(({ fn }) => useThrottledCommit<number>(fn, 50), {
      initialProps: { fn: onCommit },
    });
    return { onCommit, hook, api: () => hook.result.current };
  }

  it("commits the first value at once, then only the latest one per interval", () => {
    const { onCommit, api } = setup();
    act(() => api().push(1));
    expect(onCommit.mock.calls).toEqual([[1]]);

    act(() => {
      api().push(2);
      api().push(3);
    });
    expect(api().isPending()).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(50));
    expect(onCommit.mock.calls).toEqual([[1], [3]]);
    expect(api().isPending()).toBe(false);
  });

  it("flushes the latest value on release, even when nothing is pending", () => {
    const { onCommit, api } = setup();
    act(() => api().push(4));
    act(() => api().flush());
    expect(onCommit.mock.calls).toEqual([[4], [4]]);
  });

  it("does not let a release revert a value an outside change settled on", () => {
    const { onCommit, api } = setup();
    act(() => api().push(10));
    act(() => api().sync(70));
    act(() => api().flush());
    expect(onCommit).toHaveBeenLastCalledWith(70);
  });

  it("calls the newest callback, not the one the throttle was built with", () => {
    const { hook, api } = setup();
    const next = vi.fn();
    hook.rerender({ fn: next });
    act(() => api().push(5));
    expect(next).toHaveBeenCalledWith(5);
  });

  it("drops the trailing commit when the component unmounts", () => {
    const { onCommit, hook, api } = setup();
    act(() => {
      api().push(1);
      api().push(2);
    });
    hook.unmount();
    vi.advanceTimersByTime(100);
    expect(onCommit.mock.calls).toEqual([[1]]);
  });
});
