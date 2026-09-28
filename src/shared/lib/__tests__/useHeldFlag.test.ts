import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUSY_MIN_MS, useHeldFlag, useHeldValue } from "../useHeldFlag";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useHeldFlag", () => {
  it("a flag that falls at once still reads true for the minimum", () => {
    const { result, rerender } = renderHook(({ active }) => useHeldFlag(active), { initialProps: { active: false } });
    expect(result.current).toBe(false);

    rerender({ active: true });
    rerender({ active: false });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(BUSY_MIN_MS - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("a flag that stays up longer than the minimum falls when it does", () => {
    const { result, rerender } = renderHook(({ active }) => useHeldFlag(active), { initialProps: { active: false } });
    rerender({ active: true });
    act(() => vi.advanceTimersByTime(BUSY_MIN_MS * 2));
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it("a second rise restarts the hold", () => {
    const { result, rerender } = renderHook(({ active }) => useHeldFlag(active), { initialProps: { active: false } });
    rerender({ active: true });
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(BUSY_MIN_MS - 100));
    rerender({ active: true });
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(BUSY_MIN_MS - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("up at mount is not held: nothing was shown rising", () => {
    const { result, rerender } = renderHook(({ active }) => useHeldFlag(active), { initialProps: { active: true } });
    rerender({ active: false });
    expect(result.current).toBe(false);
  });
});

describe("useHeldValue", () => {
  it("keeps what was shown while held, then takes the new value", () => {
    const { result, rerender } = renderHook(({ value, hold }) => useHeldValue(value, hold), {
      initialProps: { value: "old" as string | null, hold: false },
    });
    rerender({ value: null, hold: true });
    expect(result.current).toBe("old");
    rerender({ value: "new", hold: true });
    expect(result.current).toBe("old");
    rerender({ value: "new", hold: false });
    expect(result.current).toBe("new");
  });
});
