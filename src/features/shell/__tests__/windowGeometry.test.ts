/**
 * windowGeometry — center-anchored geometry regression tests
 *
 * Tests cover the v2→v3 schema bump behaviour: persisting/restoring window
 * position via a center point (mode-invariant) rather than a top-left corner
 * (mode-dependent). Doubles and mock strategy: `./support/windowTestHarness`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistWindowState, restoreWindowState } from "../windowGeometry";
import { resizeToMode } from "../windowAnimator";
import {
  availableMonitorsMock,
  backend,
  captureLastSavedState,
  captureSetPositionArgs,
  centerMock,
  innerSizeMock,
  makePersistedState,
  MONITOR_1080P,
  outerPositionMock,
  outerSizeMock,
  setPositionMock,
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
// Scenario 1 — Center-anchored restore: happy path
// ---------------------------------------------------------------------------

describe("Scenario 1 — center-anchored restore: happy path", () => {
  it("setPosition called with top-left derived from persisted center and compact outer size", async () => {
    // Persisted: center = (960, 540) — dead center of a 1920×1080 monitor.
    // Boot outer size: 320×480 (compact).
    // Expected top-left: (960 - 160, 540 - 240) = (800, 300).
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    expect(setPositionMock).toHaveBeenCalledOnce();
    const pos = captureSetPositionArgs();
    expect(pos.x).toBe(800);
    expect(pos.y).toBe(300);
  });

  it("no re-save when the candidate rect is already on-screen (no clamp needed)", async () => {
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    // The resulting rect (800, 300, 320, 480) is fully inside 1920×1080 —
    // no clamp, so saveShellState must NOT have been called.
    expect(backend.patches()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Boot-time mode mismatch: the actual bug fix
// ---------------------------------------------------------------------------

describe("Scenario 2 — boot-time mode mismatch bug fix", () => {
  it("compact window placed at center of where full-mode window was, NOT at full-mode top-left", async () => {
    // Persisted center was saved when the window was full (900×620).
    // For a 900×620 full window centered at (960, 540):
    //   - top-left would have been (510, 230)
    //   - Legacy corner persistence would restore compact to (510, 230) —
    //     biased upper-left because compact is 320×480, not 900×620.
    // Center persistence instead places compact at (800, 300) — pinned to
    // the same visual center (960, 540).
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    // Boot starts in compact.
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    const pos = captureSetPositionArgs();

    // Visual center of the restored compact rect must equal the persisted center.
    const restoredCenterX = pos.x + 320 / 2;
    const restoredCenterY = pos.y + 480 / 2;
    expect(restoredCenterX).toBe(960);
    expect(restoredCenterY).toBe(540);

    // Explicitly assert it is NOT the legacy top-left of the full window.
    expect(pos.x).not.toBe(510);
    expect(pos.y).not.toBe(230);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — persistWindowState uses outerSize, not innerSize
// ---------------------------------------------------------------------------

describe("Scenario 3 — persistWindowState reads outerSize, never innerSize", () => {
  it("saves center computed from outerPosition + outerSize", async () => {
    // outerPosition = (500, 200), outerSize = (900, 648)
    // Center = (500 + 450, 200 + 324) = (950, 524)
    outerPositionMock.mockResolvedValue({ x: 500, y: 200 });
    outerSizeMock.mockResolvedValue({ width: 900, height: 648 });
    // innerSize is available but must NOT be called by persistWindowState.
    innerSizeMock.mockResolvedValue({ width: 900, height: 620 });

    setupPersistedState(
      makePersistedState({ windowCenterX: null, windowCenterY: null }),
    );

    await persistWindowState();

    const saved = captureLastSavedState();
    expect(saved.windowCenterX).toBe(950);
    expect(saved.windowCenterY).toBe(524);

    // innerSize must NOT have been called.
    expect(innerSizeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Off-screen center → clamp + re-persist corrected center
// ---------------------------------------------------------------------------

describe("Scenario 4 — off-screen center clamps and re-persists", () => {
  it("clamped position is applied and new center written back to store", async () => {
    // Persisted: center = (5000, 5000) — saved on a now-disconnected secondary
    // monitor.  Boot outer size: 320×480.
    // Candidate top-left before clamp: (5000 - 160, 5000 - 240) = (4840, 4760).
    // Monitor bounds: 0, 0, 1920×1080.
    // Max allowed x = 1920 - 320 = 1600; max allowed y = 1080 - 480 = 600.
    // Clamped top-left: (1600, 600).
    // Persisted center after clamp: (1600 + 160, 600 + 240) = (1760, 840).
    setupPersistedState(
      makePersistedState({ windowCenterX: 5000, windowCenterY: 5000 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });
    availableMonitorsMock.mockResolvedValue([MONITOR_1080P]);

    await restoreWindowState();

    // setPosition called with the clamped corner.
    const pos = captureSetPositionArgs();
    expect(pos.x).toBe(1600);
    expect(pos.y).toBe(600);

    // saveShellState must write the new (correct) center back.
    const saved = captureLastSavedState();
    expect(saved.windowCenterX).toBe(1760);
    expect(saved.windowCenterY).toBe(840);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Null center → ensureCurrentWindowOnScreen fallback
// ---------------------------------------------------------------------------

describe("Scenario 5 — null center triggers ensureCurrentWindowOnScreen fallback", () => {
  it("does not call setPosition from a saved center; calls availableMonitors for on-screen check", async () => {
    // Persisted: windowCenterX = null (fresh launch / migrated legacy all-null).
    setupPersistedState(
      makePersistedState({ windowCenterX: null, windowCenterY: null }),
    );
    // Current window is already on-screen (OS default).
    outerPositionMock.mockResolvedValue({ x: 100, y: 100 });
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    // The null-center branch must NOT call setPosition from a saved center.
    // ensureCurrentWindowOnScreen only calls setPosition when a move is needed;
    // the window is already on-screen here so no move should occur.
    expect(setPositionMock).not.toHaveBeenCalled();

    // The on-screen guard must have queried available monitors.
    expect(availableMonitorsMock).toHaveBeenCalled();
  });

  it("null center with both fields null triggers the fallback branch — not the center-restore path", async () => {
    setupPersistedState(
      makePersistedState({ windowCenterX: null, windowCenterY: null }),
    );
    outerPositionMock.mockResolvedValue({ x: 200, y: 200 });
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });
    // On-screen — no move needed.
    availableMonitorsMock.mockResolvedValue([MONITOR_1080P]);

    await restoreWindowState();

    // center() must NOT have been called — the window is already on-screen.
    expect(centerMock).not.toHaveBeenCalled();
    // setPosition should also not be called — no clamping needed.
    expect(setPositionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — No monitors available (rare / headless)
// ---------------------------------------------------------------------------

describe("Scenario 6 — no monitors available falls back to win.center()", () => {
  it("calls win.center() and persists new OS-chosen center when monitor list is empty", async () => {
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    // No monitors — ensureWindowRectOnScreen returns null.
    availableMonitorsMock.mockResolvedValue([]);

    // After center(), OS places the window somewhere; simulate that.
    centerMock.mockImplementation(async () => {
      outerPositionMock.mockResolvedValue({ x: 800, y: 300 });
      outerSizeMock.mockResolvedValue({ width: 320, height: 480 });
    });

    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );

    await restoreWindowState();

    // win.center() must have been called as the fallback.
    expect(centerMock).toHaveBeenCalledOnce();

    // saveShellState must write back non-null center coordinates.
    const saved = captureLastSavedState();
    expect(saved.windowCenterX).not.toBeNull();
    expect(saved.windowCenterY).not.toBeNull();
    expect(typeof saved.windowCenterX).toBe("number");
    expect(typeof saved.windowCenterY).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — rectCenter / rectTopLeftFromCenter are inverse operations
// ---------------------------------------------------------------------------

describe("Scenario 7 — rectCenter and rectTopLeftFromCenter inverse relationship", () => {
  // These helpers are private (not exported). We cover them implicitly through
  // the integration scenarios above — every setPosition call exercises
  // rectTopLeftFromCenter and every saveShellState call after a clamp
  // exercises rectCenter.
  //
  // Decision: do NOT export them just for unit testing. The helpers are pure
  // arithmetic (2 lines each), the risk of a silent bug not caught by the
  // integration tests is negligible, and expanding the public surface of
  // windowGeometry.ts creates a maintenance burden (exported = semver-visible).
  //
  // The tests below exercise the inverse property *through* the public API to
  // give explicit regression coverage without leaking the private symbols.

  it("round-trip: persisted center survives restore without drift (1080p, compact)", async () => {
    const centerX = 640;
    const centerY = 400;
    setupPersistedState(
      makePersistedState({ windowCenterX: centerX, windowCenterY: centerY }),
    );
    const outerW = 320;
    const outerH = 480;
    outerSizeMock.mockResolvedValue({ width: outerW, height: outerH });

    await restoreWindowState();

    const pos = captureSetPositionArgs();
    // Center of the restored rect must equal the persisted center (±0 for even sizes).
    expect(pos.x + outerW / 2).toBe(centerX);
    expect(pos.y + outerH / 2).toBe(centerY);
  });

  it("round-trip: persist then restore gives back the same center (full-mode outer size)", async () => {
    const originX = 100;
    const originY = 150;
    const outerW = 900;
    const outerH = 648;
    outerPositionMock.mockResolvedValue({ x: originX, y: originY });
    outerSizeMock.mockResolvedValue({ width: outerW, height: outerH });
    setupPersistedState(
      makePersistedState({ windowCenterX: null, windowCenterY: null }),
    );

    await persistWindowState();

    const saved = captureLastSavedState();
    const expectedCenterX = originX + Math.round(outerW / 2);
    const expectedCenterY = originY + Math.round(outerH / 2);
    expect(saved.windowCenterX).toBe(expectedCenterX);
    expect(saved.windowCenterY).toBe(expectedCenterY);

    // Now simulate a restore with a different (compact) outer size to verify
    // the inverse: top-left from center.
    setupPersistedState(
      makePersistedState({
        windowCenterX: saved.windowCenterX,
        windowCenterY: saved.windowCenterY,
      }),
    );
    const compactW = 320;
    const compactH = 480;
    outerSizeMock.mockResolvedValue({ width: compactW, height: compactH });
    availableMonitorsMock.mockResolvedValue([MONITOR_1080P]);
    setPositionMock.mockClear();
    setPositionMock.mockResolvedValue(undefined);

    await restoreWindowState();

    const pos = captureSetPositionArgs();
    expect(pos.x + Math.round(compactW / 2)).toBe(expectedCenterX);
    expect(pos.y + Math.round(compactH / 2)).toBe(expectedCenterY);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Center-preserve: single setPosition per restore
// ---------------------------------------------------------------------------

describe("Scenario 8 — center-preserve: single setPosition per restore", () => {
  it("restores window at compact outer size with correct center", async () => {
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    const pos = captureSetPositionArgs();
    // Center of the restored window equals the persisted center.
    expect(pos.x + 160).toBe(960);
    expect(pos.y + 240).toBe(540);
  });

  it("valid center on-screen: setPosition called exactly once, no spurious second move", async () => {
    // When windowCenterX/Y are non-null and the derived rect is already
    // on-screen, setPosition must be called exactly once — not zero times
    // (center-restore path fired) and not twice (spurious second move).
    setupPersistedState(
      makePersistedState({ windowCenterX: 960, windowCenterY: 540 }),
    );
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    expect(setPositionMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Scenario 13 — a hand-resized window survives a reload
// ---------------------------------------------------------------------------

describe("Scenario 13 — dragging the window edge is remembered", () => {
  it("records the new full size, so a reload does not snap back to the last toggle", async () => {
    setupPersistedState(
      makePersistedState({ uiMode: "full", lastFullSize: { width: 900, height: 620 } }),
    );
    // The user drags the window out to 1200×800; inner is what the restore path
    // reads back, so that is what has to be stored.
    innerSizeMock.mockResolvedValue({ width: 1200, height: 800 });
    outerSizeMock.mockResolvedValue({ width: 1200, height: 828 });

    await persistWindowState();

    expect(captureLastSavedState().lastFullSize).toMatchObject({ width: 1200, height: 800 });
  });

  it("stores logical inner px, so the size does not creep by the title bar", async () => {
    // outer is 28 px taller than inner. Persisting the outer rect would restore
    // 828, whose next save reads 856, and the window grows on every cycle.
    setupPersistedState(makePersistedState({ uiMode: "full" }));
    innerSizeMock.mockResolvedValue({ width: 1200, height: 800 });
    outerSizeMock.mockResolvedValue({ width: 1200, height: 828 });

    await persistWindowState();

    expect(captureLastSavedState().lastFullSize).not.toMatchObject({ height: 828 });
  });

  it("leaves the remembered full size alone while in compact", async () => {
    setupPersistedState(
      makePersistedState({ uiMode: "compact", lastFullSize: { width: 900, height: 620 } }),
    );
    innerSizeMock.mockResolvedValue({ width: 320, height: 452 });

    await persistWindowState();

    expect(captureLastSavedState().lastFullSize).toMatchObject({ width: 900, height: 620 });
  });

  it("does not let the boot resize overwrite the size it is restoring", async () => {
    // `resizeToMode` opts out of the capture: at boot the window is still
    // compact-sized when it runs, so capturing would store 320×452 as the full
    // size — the exact regression Scenario 11 guards from the other direction.
    setupPersistedState(
      makePersistedState({ uiMode: "full", lastFullSize: { width: 900, height: 620 } }),
    );
    innerSizeMock.mockResolvedValue({ width: 320, height: 452 });

    await resizeToMode("full", { animate: false });

    expect(captureLastSavedState().lastFullSize).toMatchObject({ width: 900, height: 620 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 14 — gaps a mutation sweep found: the monitor pick and the anim floor
// ---------------------------------------------------------------------------

describe("Scenario 14 — clamping against the right monitor", () => {
  const LEFT: MonitorInfo = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };
  const RIGHT: MonitorInfo = { position: { x: 1920, y: 0 }, size: { width: 1920, height: 1080 } };

  it("clamps an off-screen window into the monitor it is nearest, not the first one", async () => {
    // Making pickNearestMonitor return the head of the list survived the whole
    // suite: every other case has a single monitor, where first == nearest.
    availableMonitorsMock.mockResolvedValue([LEFT, RIGHT]);
    // Centre far to the right and below both screens, so a clamp is required.
    setupPersistedState(makePersistedState({ windowCenterX: 3800, windowCenterY: 2000 }));
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    // Clamped into the right-hand monitor: x lands inside [1920, 3840), which a
    // fallback to the first monitor could not produce.
    expect(captureSetPositionArgs().x).toBeGreaterThanOrEqual(1920);
  });

  it("still uses the only monitor when there is one", async () => {
    availableMonitorsMock.mockResolvedValue([LEFT]);
    setupPersistedState(makePersistedState({ windowCenterX: 3800, windowCenterY: 2000 }));
    outerSizeMock.mockResolvedValue({ width: 320, height: 480 });

    await restoreWindowState();

    expect(captureSetPositionArgs().x).toBeLessThan(1920);
  });
});

