/**
 * windowLifecycle — boot: restore, show, and the startup marker. Doubles and
 * mock strategy: `./support/windowTestHarness`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makePersistedState,
  readStartHiddenMock,
  setFocusMock,
  setPositionMock,
  setupPersistedState,
  showMock,
  unminimizeMock,
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
// Scenario 17 — an autostart launch (`--tray`) stays in the tray
// ---------------------------------------------------------------------------

describe("Scenario 17 — an autostart launch stays in the tray", () => {
  // `initWindowLifecycle` runs once per module instance, so each case loads a
  // fresh one.
  async function freshInit() {
    vi.resetModules();
    const lifecycle = await import("../windowLifecycle");
    await lifecycle.initWindowLifecycle();
    return lifecycle;
  }

  it("restores the geometry but never shows or focuses the window", async () => {
    readStartHiddenMock.mockResolvedValue(true);
    setupPersistedState(makePersistedState({ windowCenterX: 960, windowCenterY: 540 }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const { STARTUP_READY_MARKER } = await freshInit();

    expect(setPositionMock).toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
    expect(unminimizeMock).not.toHaveBeenCalled();
    expect(setFocusMock).not.toHaveBeenCalled();
    // The launch smoke waits for this line; a hidden start still reaches it.
    expect(info).toHaveBeenCalledWith(STARTUP_READY_MARKER);
  });

  it("shows and focuses the window on an ordinary launch", async () => {
    readStartHiddenMock.mockResolvedValue(false);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await freshInit();

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(setFocusMock).toHaveBeenCalledTimes(1);
  });
});
