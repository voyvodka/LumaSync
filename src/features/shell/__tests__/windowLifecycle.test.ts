/**
 * windowLifecycle — boot: restore, show, and the startup marker. Doubles and
 * mock strategy: `./support/windowTestHarness`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backend,
  makePersistedState,
  readStartHiddenMock,
  setFocusMock,
  setPositionMock,
  setSizeMock,
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
  // Each case is a fresh launch unless it reloads on purpose.
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    vi.stubEnv("DEV", false);
    readStartHiddenMock.mockResolvedValue(false);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await freshInit();

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(setFocusMock).toHaveBeenCalledTimes(1);
  });

  // Every Rust edit relaunches a dev build; taking focus each time pulled the developer out of
  // whatever they were typing in. Rust hands activation back on macOS.
  it("shows a dev build's window without taking focus", async () => {
    vi.stubEnv("DEV", true);
    readStartHiddenMock.mockResolvedValue(false);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await freshInit();

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(setFocusMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A page reload (Vite in dev, the error boundary's fallback) is not a launch
// ---------------------------------------------------------------------------

describe("a page reload of the same window", () => {
  it("leaves the window where it is and never takes focus", async () => {
    vi.stubEnv("DEV", false);
    readStartHiddenMock.mockResolvedValue(false);
    setupPersistedState(makePersistedState({ windowCenterX: 960, windowCenterY: 540 }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.resetModules();
    await (await import("../windowLifecycle")).initWindowLifecycle();
    expect(showMock).toHaveBeenCalledTimes(1);
    expect(setFocusMock).toHaveBeenCalledTimes(1);

    showMock.mockClear();
    setFocusMock.mockClear();
    unminimizeMock.mockClear();
    setPositionMock.mockClear();
    vi.resetModules();
    const reloaded = await import("../windowLifecycle");
    await reloaded.initWindowLifecycle();

    expect(showMock).not.toHaveBeenCalled();
    expect(unminimizeMock).not.toHaveBeenCalled();
    expect(setFocusMock).not.toHaveBeenCalled();
    expect(setPositionMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(reloaded.STARTUP_READY_MARKER);
  });
});

// ---------------------------------------------------------------------------
// A launch reads the state once, and rewrites none of it
// ---------------------------------------------------------------------------

describe("a launch into full mode", () => {
  // Bootstrap had already read the state; reading it again at each step and saving back the mode
  // and centre it was restored from cost round trips and disk syncs before the first frame.
  it("grows to full from the state it is given, reading and writing nothing before it shows", async () => {
    const state = makePersistedState({ uiMode: "full", windowCenterX: 960, windowCenterY: 540 });
    setupPersistedState(state);
    readStartHiddenMock.mockResolvedValue(false);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.spyOn(backend, "invoke");

    vi.resetModules();
    await (await import("../windowLifecycle")).initWindowLifecycle({ state });

    const shownAt = showMock.mock.invocationCallOrder[0];
    const readsBeforeShow = invoke.mock.calls.filter(
      ([command], i) => command === "get_shell_state" && invoke.mock.invocationCallOrder[i] < shownAt,
    );
    expect(readsBeforeShow).toHaveLength(0);
    expect(backend.patches()).toHaveLength(0);
    expect(setSizeMock).toHaveBeenCalled();
  });
});
