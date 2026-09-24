/**
 * Shared doubles for the window lifecycle suites — windowShellState,
 * windowGeometry, windowAnimator and windowLifecycle.
 *
 * Mock strategy: stub the Tauri window API at the @tauri-apps/api/window
 * boundary AND `invoke` at @tauri-apps/api/core, answered by an in-memory
 * stand-in for the Rust shell-state store. The real loadShellState /
 * saveShellState code paths and the real invoke bridge are exercised (same
 * depth as the persistence migration.*.test.ts suites) rather than mocking
 * windowLifecycle exports themselves.
 *
 * Each suite loads this through `vi.hoisted` and hands the `*Module` objects to
 * its `vi.mock` factories, so a suite that calls `vi.resetModules()` still
 * asserts on the same doubles its fresh modules call.
 */

import { expect, vi } from "vitest";

import {
  DEFAULT_SHELL_STATE,
  type ShellState,
} from "@/shared/contracts/shell";
import { createFakeShellStateBackend, type FakeShellStateBackend } from "@/test/fakeShellStateBackend";

// ---------------------------------------------------------------------------
// Shell-state backend — the real bridge reaches it through `invoke`.
// ---------------------------------------------------------------------------

let currentBackend = createFakeShellStateBackend();

/** Stable handle on the backend {@link resetWindowHarness} replaces before each test. */
export const backend: FakeShellStateBackend = {
  state: () => currentBackend.state(),
  seed: (state) => currentBackend.seed(state),
  revision: () => currentBackend.revision(),
  patches: () => currentBackend.patches(),
  replaces: () => currentBackend.replaces(),
  invoke: (command, args) => currentBackend.invoke(command, args),
  listen: (event, handler) => currentBackend.listen(event, handler),
  failNextWrite: (error) => currentBackend.failNextWrite(error),
  useMacrotaskLatency: (on) => currentBackend.useMacrotaskLatency(on),
};

export const tauriCoreModule = {
  invoke: (command: string, args?: unknown) =>
    backend.invoke(command, args) ?? Promise.reject(new Error(`unexpected invoke: ${command}`)),
};

// ---------------------------------------------------------------------------
// Window mock — richer than the App.*.test.tsx one; we need outerPosition, outerSize,
// innerSize, setPosition, center, availableMonitors, onMoved, onResized.
// ---------------------------------------------------------------------------

// Each mock is typed via its initialiser so TypeScript can see the return shape.
export const outerPositionMock = vi.fn(() =>
  Promise.resolve<{ x: number; y: number }>({ x: 800, y: 300 }),
);
export const outerSizeMock = vi.fn(() =>
  Promise.resolve<{ width: number; height: number }>({ width: 320, height: 480 }),
);
export const innerSizeMock = vi.fn(() =>
  Promise.resolve<{ width: number; height: number }>({ width: 320, height: 452 }),
);
export const setPositionMock = vi.fn((_arg: unknown) => Promise.resolve<void>(undefined));
export const setSizeMock = vi.fn((_arg: unknown) => Promise.resolve<void>(undefined));
export const scaleFactorMock = vi.fn(() => Promise.resolve<number>(1));
export const centerMock = vi.fn(() => Promise.resolve<void>(undefined));
export const setMinSizeMock = vi.fn((_arg: unknown) => Promise.resolve<void>(undefined));
export const showMock = vi.fn(() => Promise.resolve<void>(undefined));
export const unminimizeMock = vi.fn(() => Promise.resolve<void>(undefined));
export const setFocusMock = vi.fn(() => Promise.resolve<void>(undefined));
export const onMovedMock = vi.fn((_cb: unknown) =>
  Promise.resolve<() => void>(() => {}),
);
export const onResizedMock = vi.fn((_cb: unknown) =>
  Promise.resolve<() => void>(() => {}),
);

export type MonitorInfo = {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
};

export const availableMonitorsMock = vi.fn(() =>
  Promise.resolve<MonitorInfo[]>([
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
  ]),
);

export const tauriWindowModule = {
  getCurrentWindow: () => ({
    outerPosition: () => outerPositionMock(),
    outerSize: () => outerSizeMock(),
    innerSize: () => innerSizeMock(),
    setPosition: (arg: unknown) => setPositionMock(arg),
    setSize: (arg: unknown) => setSizeMock(arg),
    scaleFactor: () => scaleFactorMock(),
    center: () => centerMock(),
    setMinSize: (arg: unknown) => setMinSizeMock(arg),
    show: () => showMock(),
    unminimize: () => unminimizeMock(),
    setFocus: () => setFocusMock(),
    onMoved: (cb: unknown) => onMovedMock(cb),
    onResized: (cb: unknown) => onResizedMock(cb),
  }),
  availableMonitors: () => availableMonitorsMock(),
  // Constructors — capture the args so we can assert what was passed.
  PhysicalPosition: class PhysicalPosition {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
  LogicalSize: class LogicalSize {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
  },
  LogicalPosition: class LogicalPosition {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
};

// @tauri-apps/api/event — used by initCloseToTrayHint inside initWindowLifecycle
export const tauriEventModule = {
  listen: vi.fn().mockReturnValue(Promise.resolve(() => {})),
};

export const readStartHiddenMock = vi.fn(() => Promise.resolve(false));
export const launchApiModule = {
  readStartHidden: () => readStartHiddenMock(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A persisted shell state at the current schema, so no migration writes back. */
export function makePersistedState(overrides: Partial<ShellState>): ShellState {
  return { ...DEFAULT_SHELL_STATE, ...overrides };
}

export function setupPersistedState(state: ShellState) {
  backend.seed(state as unknown as Record<string, unknown>);
}

/**
 * Extract the PhysicalPosition args from the first setPosition call.
 * Returns `{ x, y }` of the physical position passed to win.setPosition().
 */
export function captureSetPositionArgs(): { x: number; y: number } {
  expect(setPositionMock).toHaveBeenCalled();
  const arg = setPositionMock.mock.calls[0][0] as { x: number; y: number };
  return { x: arg.x, y: arg.y };
}

/** The stored state after the last save, which must have happened. */
export function captureLastSavedState(): ShellState {
  expect(backend.patches().length).toBeGreaterThan(0);
  return backend.state() as unknown as ShellState;
}

/** A single monitor covering a typical 1920×1080 display */
export const MONITOR_1080P: MonitorInfo = {
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
};

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

/** Each suite's `beforeEach`. */
export function resetWindowHarness(): void {
  vi.clearAllMocks();

  // Re-apply default implementations after clearAllMocks wipes them.
  outerPositionMock.mockResolvedValue({ x: 800, y: 300 });
  outerSizeMock.mockResolvedValue({ width: 320, height: 480 });
  innerSizeMock.mockResolvedValue({ width: 320, height: 452 });
  centerMock.mockImplementation(async () => {
    // After center(), subsequent outerPosition calls reflect the new placement.
    outerPositionMock.mockResolvedValue({ x: 800, y: 300 });
  });
  availableMonitorsMock.mockResolvedValue([MONITOR_1080P]);
  scaleFactorMock.mockResolvedValue(1);
  currentBackend = createFakeShellStateBackend();
  setPositionMock.mockResolvedValue(undefined);
  showMock.mockResolvedValue(undefined);
  setMinSizeMock.mockResolvedValue(undefined);
  onMovedMock.mockResolvedValue(() => {});
  onResizedMock.mockResolvedValue(() => {});
  unminimizeMock.mockResolvedValue(undefined);
  setFocusMock.mockResolvedValue(undefined);
}
