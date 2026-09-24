/**
 * windowAnimator — the UI mode resize: boot restore, work-area clamping, the
 * animation floor and first-run sizing. Doubles and mock strategy:
 * `./support/windowTestHarness`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resizeToMode } from "../windowAnimator";
import { firstRunFullSize, fitSizeToWorkArea, schedulePersistWindowState } from "../windowGeometry";
import {
  availableMonitorsMock,
  backend,
  captureLastSavedState,
  innerSizeMock,
  makePersistedState,
  outerPositionMock,
  scaleFactorMock,
  setMinSizeMock,
  setPositionMock,
  setSizeMock,
  setupPersistedState,
  type MonitorInfo,
} from "./support/windowTestHarness";

const harness = await vi.hoisted(() => import("./support/windowTestHarness"));

vi.mock("@tauri-apps/api/core", () => harness.tauriCoreModule);
vi.mock("@tauri-apps/api/window", () => harness.tauriWindowModule);
vi.mock("@tauri-apps/api/event", () => harness.tauriEventModule);
vi.mock("../launchApi", () => harness.launchApiModule);

beforeEach(() => {
  harness.resetWindowHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 11 — boot restores the persisted UI mode without animating
// ---------------------------------------------------------------------------

describe("Scenario 11 — boot restores the persisted UI mode", () => {
  it("un-animated resize lands the final rect in one setSize, not a frame sequence", async () => {
    setupPersistedState(
      makePersistedState({
        uiMode: "full",
        lastFullSize: { width: 900, height: 620 },
      }),
    );

    await resizeToMode("full", { animate: false });

    // `animateWindowRect` cannot take a zero duration — `t` would be NaN and the
    // loop would never exit — so the boot path must bypass it entirely.
    expect(setSizeMock).toHaveBeenCalledTimes(1);
    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 900, height: 620 });
  });

  it("restores the user's last full size rather than the default", async () => {
    setupPersistedState(
      makePersistedState({
        uiMode: "full",
        lastFullSize: { width: 1280, height: 800 },
      }),
    );

    await resizeToMode("full", { animate: false });

    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 1280, height: 800 });
  });

  it("grows around the current centre instead of jumping to monitor centre", async () => {
    // The "from" rect comes from innerSize, not outerSize: 320×452 at
    // (800, 300) ⇒ centre (960, 526). Growing to 900×620 about that centre
    // puts the top-left at (510, 216) — on-screen, so the clamp leaves it.
    setupPersistedState(
      makePersistedState({
        uiMode: "full",
        lastFullSize: { width: 900, height: 620 },
      }),
    );

    await resizeToMode("full", { animate: false });

    const position = setPositionMock.mock.calls[0][0] as { x: number; y: number };
    expect(position).toMatchObject({ x: 510, y: 216 });
  });

  it("re-entering full does not overwrite the remembered full size", async () => {
    // The capture branch is guarded on *leaving* full. Boot calls this while
    // already in full, so a smaller live window must not become the memory.
    innerSizeMock.mockResolvedValue({ width: 320, height: 452 });
    setupPersistedState(
      makePersistedState({
        uiMode: "full",
        lastFullSize: { width: 900, height: 620 },
      }),
    );

    await resizeToMode("full", { animate: false });

    expect(captureLastSavedState().lastFullSize).toMatchObject({ width: 900, height: 620 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — a target size larger than the screen
// ---------------------------------------------------------------------------

describe("Scenario 12 — the target size is clamped to the work area", () => {
  /** A monitor whose usable height is shorter than its resolution. */
  function monitorWithWorkArea(
    size: { width: number; height: number },
    work: { width: number; height: number },
  ): MonitorInfo {
    return {
      position: { x: 0, y: 0 },
      size,
      workArea: { position: { x: 0, y: 0 }, size: work },
    };
  }

  it("shrinks the full default to fit a screen it is taller than", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorWithWorkArea({ width: 1024, height: 600 }, { width: 1024, height: 560 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 900, height: 560 });
  });

  it("reads the work area, not the resolution — a tall taskbar still clamps", async () => {
    // 620 fits inside 768 and does not fit inside 600, so a pass that only
    // looked at `size` would leave the window overlapping the taskbar.
    availableMonitorsMock.mockResolvedValue([
      monitorWithWorkArea({ width: 1366, height: 768 }, { width: 1366, height: 600 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 900, height: 600 });
  });

  it("clamps a full size remembered from a larger display", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorWithWorkArea({ width: 1280, height: 800 }, { width: 1280, height: 760 }),
    ]);
    setupPersistedState(
      makePersistedState({ uiMode: "compact", lastFullSize: { width: 1900, height: 1000 } }),
    );

    await resizeToMode("full", { animate: false });

    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 1280, height: 760 });
  });

  it("lowers the min-size too, or the OS would refuse every resize that fits", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorWithWorkArea({ width: 720, height: 600 }, { width: 700, height: 500 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    // The last call is the target mode's floor; earlier ones are the compact
    // floor the animator drops to.
    const calls = setMinSizeMock.mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({ width: 700, height: 500 });
  });

  it("leaves a size that already fits alone", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorWithWorkArea({ width: 1920, height: 1080 }, { width: 1920, height: 1040 }),
    ]);
    setupPersistedState(
      makePersistedState({ uiMode: "compact", lastFullSize: { width: 900, height: 620 } }),
    );

    await resizeToMode("full", { animate: false });

    const size = setSizeMock.mock.calls[0][0] as { width: number; height: number };
    expect(size).toMatchObject({ width: 900, height: 620 });
  });

  it("never grows a size to fill the screen", () => {
    expect(fitSizeToWorkArea({ width: 900, height: 620 }, { width: 3840, height: 2100 }))
      .toEqual({ width: 900, height: 620 });
  });

  it("passes the size through when no work area is known", () => {
    expect(fitSizeToWorkArea({ width: 900, height: 620 }, null))
      .toEqual({ width: 900, height: 620 });
  });
});

describe("Scenario 15 — the animator drops the floor to compact", () => {
  it("lowers the min size to the compact floor before animating, whatever the target", async () => {
    // Intermediate frames pass through sizes smaller than the full floor, and
    // the OS rejects a setSize below the current minimum. Using the target
    // mode's floor here survived the suite because every other case animates
    // with `animate: false`.
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full");

    const floors = setMinSizeMock.mock.calls.map((c) => c[0] as { width: number; height: number });
    expect(floors[0]).toMatchObject({ width: 300, height: 420 });
    expect(floors[floors.length - 1]).toMatchObject({ width: 800, height: 560 });
  });
});

describe("Scenario 15b — the animator finishes when animation frames stop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches the target rect, floor and persisted mode with rAF never firing", async () => {
    // A hidden, occluded or screen-locked window gets no frames. The loop used
    // to await one unbounded and never return, holding `isAnimatingMode` and
    // the UI-mode transition lock behind it.
    const cancelSpy = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", cancelSpy);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    const outcome = await Promise.race([
      resizeToMode("full").then(() => "done" as const),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 2000)),
    ]);

    expect(outcome).toBe("done");
    expect(cancelSpy).toHaveBeenCalled();
    const floors = setMinSizeMock.mock.calls.map((c) => c[0] as { width: number; height: number });
    expect(floors[floors.length - 1]).toMatchObject({ width: 800, height: 560 });
    const saved = backend.patches().map((p) => p.set.uiMode);
    expect(saved).toContain("full");
  });
});

describe("Scenario 15c — failed intermediate frames are logged, once per animation", () => {
  it("logs the first frame rejection with the [LumaSync] prefix and stays quiet after", async () => {
    // Intermediate frames are fire-and-forget; their rejections used to be
    // swallowed by `.catch(() => {})`, so a window dying mid-resize left no trace.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frameError = new Error("window destroyed");
    setSizeMock
      .mockRejectedValueOnce(frameError)
      .mockRejectedValueOnce(frameError)
      .mockRejectedValueOnce(frameError);
    setPositionMock.mockRejectedValueOnce(frameError).mockRejectedValueOnce(frameError);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full");

    const frameWarnings = warnSpy.mock.calls.filter(
      ([message]) =>
        typeof message === "string" && message.startsWith("[LumaSync] window resize animation"),
    );
    expect(frameWarnings).toHaveLength(1);
    expect(frameWarnings[0][1]).toBe(frameError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 16 — first run sizes full mode to the screen
// ---------------------------------------------------------------------------

describe("Scenario 16 — first-run full size follows the display", () => {
  function monitorAt(
    x: number,
    size: { width: number; height: number },
    work: { width: number; height: number },
  ): MonitorInfo {
    return {
      position: { x, y: 0 },
      size,
      workArea: { position: { x, y: 0 }, size: work },
    };
  }

  function lastSetSize(): { width: number; height: number } {
    const calls = setSizeMock.mock.calls;
    return calls[calls.length - 1][0] as { width: number; height: number };
  }

  it("scales up on a 1440p-logical Retina panel, converting physical px first", async () => {
    // 5120×2800 physical at 2× is 2560×1400 logical; 62% of 1400 is 868,
    // so the design size scales by 1.4 — height is the binding side.
    scaleFactorMock.mockResolvedValue(2);
    innerSizeMock.mockResolvedValue({ width: 640, height: 904 });
    outerPositionMock.mockResolvedValue({ x: 2000, y: 1000 });
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 5120, height: 2880 }, { width: 5120, height: 2800 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 1260, height: 868 });
  });

  it("caps the scale on a 4K display at 1×, keeping the full-mode aspect", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 3840, height: 2160 }, { width: 3840, height: 2120 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 1440, height: 992 });
  });

  it("never goes below the 900×620 design size on a modest screen", () => {
    // 62% of a 1280×775 work area is smaller than the design size.
    expect(firstRunFullSize({ width: 1280, height: 775 })).toEqual({ width: 900, height: 620 });
  });

  it("lets a persisted full size win, even on a display that would grow it", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 3840, height: 2160 }, { width: 3840, height: 2120 }),
    ]);
    setupPersistedState(
      makePersistedState({ uiMode: "compact", lastFullSize: { width: 1000, height: 700 } }),
    );

    await resizeToMode("full", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 1000, height: 700 });
  });

  it("still shrink-clamps on a HiDPI screen smaller than the design size", async () => {
    // 2048×1120 physical at 2× is 1024×560 logical: the floor is not allowed
    // to push the window past the work area.
    scaleFactorMock.mockResolvedValue(2);
    innerSizeMock.mockResolvedValue({ width: 640, height: 904 });
    outerPositionMock.mockResolvedValue({ x: 600, y: 100 });
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 2048, height: 1200 }, { width: 2048, height: 1120 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 900, height: 560 });
  });

  it("sizes against the monitor the window is on, not the first one listed", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 1920, height: 1080 }, { width: 1920, height: 1040 }),
      monitorAt(1920, { width: 3840, height: 2160 }, { width: 3840, height: 2120 }),
    ]);
    outerPositionMock.mockResolvedValue({ x: 3500, y: 900 });
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 1440, height: 992 });
  });

  it("leaves compact at its fixed size on a large display", async () => {
    availableMonitorsMock.mockResolvedValue([
      monitorAt(0, { width: 3840, height: 2160 }, { width: 3840, height: 2120 }),
    ]);
    setupPersistedState(makePersistedState({ uiMode: "full" }));

    await resizeToMode("compact", { animate: false });

    expect(lastSetSize()).toMatchObject({ width: 320, height: 480 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 18 — the animator's own frames are not persisted as the user's rect
// ---------------------------------------------------------------------------

describe("Scenario 18 — a resize event mid-animation is not persisted", () => {
  it("holds back the debounced persist a frame triggers", async () => {
    // The flag lives in windowGeometry and the animator raises it from another
    // module. The 180 ms debounce fires inside the 220 ms animation, so a flag
    // that never rises writes an intermediate frame to disk before `finally`
    // gets to cancel it.
    setSizeMock.mockImplementationOnce((_arg: unknown) => {
      schedulePersistWindowState();
      return Promise.resolve();
    });
    setupPersistedState(makePersistedState({ uiMode: "compact" }));

    await resizeToMode("full");
    await new Promise((resolve) => setTimeout(resolve, 250));

    // resizeToMode's own two writes: the mode, then the settled rect.
    expect(backend.patches()).toHaveLength(2);
  });
});

