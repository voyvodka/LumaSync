import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../../model/contracts";
import { useLightingModePersistence } from "../useLightingModePersistence";

const saveShellStateMock = vi.fn();

vi.mock("@/features/shell/windowLifecycle", () => ({
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
}));

const solid = (r: number): LightingModeConfig => ({
  kind: LIGHTING_MODE_KIND.SOLID,
  solid: { r, g: 0, b: 0, brightness: 1 },
});

describe("useLightingModePersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    saveShellStateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of commits into a single debounced write", () => {
    const { result } = renderHook(() => useLightingModePersistence());

    act(() => {
      result.current(solid(1));
      result.current(solid(2));
      result.current(solid(3));
    });
    expect(saveShellStateMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(saveShellStateMock).toHaveBeenCalledOnce();
    expect(saveShellStateMock).toHaveBeenCalledWith({ lightingMode: solid(3) });
  });

  it("flushes the pending write on pagehide (INV-9)", () => {
    const { result } = renderHook(() => useLightingModePersistence());
    act(() => {
      result.current(solid(7));
    });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(saveShellStateMock).toHaveBeenCalledWith({ lightingMode: solid(7) });

    // The timer must not fire a second write afterwards (INV-10).
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(saveShellStateMock).toHaveBeenCalledOnce();
  });

  it("flushes when the document becomes hidden, and not when it becomes visible", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const { result } = renderHook(() => useLightingModePersistence());

    act(() => {
      result.current(solid(1));
    });
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(saveShellStateMock).not.toHaveBeenCalled();

    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(saveShellStateMock).toHaveBeenCalledOnce();
    visibility.mockRestore();
  });

  it("flushes on unmount", () => {
    const { result, unmount } = renderHook(() => useLightingModePersistence());
    act(() => {
      result.current(solid(9));
    });

    unmount();
    expect(saveShellStateMock).toHaveBeenCalledWith({ lightingMode: solid(9) });
  });

  it("does not write anything when nothing is pending", () => {
    const { unmount } = renderHook(() => useLightingModePersistence());
    unmount();
    expect(saveShellStateMock).not.toHaveBeenCalled();
  });
});
