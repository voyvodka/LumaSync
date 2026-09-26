import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePresence } from "../usePresence";

describe("usePresence", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute("data-reduced-motion");
  });

  it("stays mounted and leaving until its exit is over, then goes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ show }) => usePresence(show, 300), { initialProps: { show: true } });
    expect(result.current).toEqual({ mounted: true, leaving: false });

    rerender({ show: false });
    expect(result.current).toEqual({ mounted: true, leaving: true });

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ mounted: false, leaving: false });
  });

  it("comes straight back if shown again while leaving", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ show }) => usePresence(show, 300), { initialProps: { show: true } });
    rerender({ show: false });
    rerender({ show: true });
    expect(result.current).toEqual({ mounted: true, leaving: false });

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ mounted: true, leaving: false });
  });

  it("goes at once with motion reduced", () => {
    document.documentElement.setAttribute("data-reduced-motion", "");
    const { result, rerender } = renderHook(({ show }) => usePresence(show, 300), { initialProps: { show: true } });
    rerender({ show: false });
    expect(result.current).toEqual({ mounted: false, leaving: false });
  });
});
