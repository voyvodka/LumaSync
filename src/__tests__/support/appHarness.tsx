// Shared harness for the App.*.test.tsx files: the module mocks every one of
// them installs, the lighting backend they drive, and the fixtures. Each test
// file registers the mocks itself (`vi.mock` is hoisted per file) with a
// factory that returns the matching `mock*` export below.
//
// Nothing here may import a module those files mock: the factories import this
// file, and a mocked module reached from here would wait on its own factory.

import { act, screen, waitFor } from "@testing-library/react";
import { memo, useReducer } from "react";
import { expect, vi } from "vitest";

import {
  useLightingActions,
  useLightingControlState,
  type LightingControlActions,
} from "@/features/mode/state/lightingControl";
import { useLeaveGuardRegistrar, useNavigationState } from "@/features/shell/navigationStore";
import { useHueShellStatus } from "@/features/hue/state/hueShellStatus";
import { runtimeStatus } from "@/features/hue/__tests__/fakeHueHealth";
import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import type {
  ApplyOutputsOutcome,
  ApplyOutputsRequest,
  ApplyOutputsResult,
  LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";
import type { RuntimeHealth } from "@/shared/contracts/telemetry";

// ---------------------------------------------------------------------------
// Per-test state. Reset by `resetAppHarness()` in every file's beforeEach.
// ---------------------------------------------------------------------------

export const env = {
  // Controllable isConnected for hot-plug tests
  isConnected: true,
  activeWledIp: null as string | null,
  // Idle unless a test opens the update prompt on purpose.
  updaterState: { status: "idle" } as { status: string; update?: unknown; progress?: number },
  checkFailedNotice: null as { message: string } | null,
  /** Re-renders the component holding the mocked `useAutoUpdater`, as a real state change would. */
  rerenderUpdater: null as (() => void) | null,
  publishRuntime: null as ((snapshot: LightingRuntimeSnapshot) => void) | null,
  pushHealth: null as ((health: RuntimeHealth) => void) | null,
  lastLayoutProps: {} as Record<string, unknown>,
  lastLightingActions: null as LightingControlActions | null,
  /** Renders of the memoised layout itself: App handing it new props. */
  layoutRenders: 0,
  /** Renders of the store subscriber inside it. */
  layoutProbeRenders: 0,
  /** The status bar gets a fresh `items` array every App render, so this counts App renders. */
  statusBarRenders: 0,
  revision: 0,
  runtime: null as unknown as LightingRuntimeSnapshot,
  /** A move the probe's leave guard is holding, as LED Setup holds one over an unsaved draft. */
  heldLeave: null as (() => void) | null,
};

export const loadShellStateMock = vi.fn();
export const saveShellStateMock = vi.fn();
export const initWindowLifecycleMock = vi.fn();
export const resizeToModeMock = vi.fn();
export const checkForUpdatesMock = vi.fn().mockResolvedValue(undefined);
export const checkForUpdatesInBackgroundMock = vi.fn().mockResolvedValue(undefined);
// Mock invoke for Tauri commands (used in bootstrap for USB status check)
export const invokeMock = vi.fn();
export const applyOutputsMock = vi.fn();
export const retuneLightingMock = vi.fn();
export const releaseHueOutputMock = vi.fn();
export const getLightingRuntimeMock = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// App renders without the I18nextProvider that providers.tsx supplies in the
// real shell, so any component reaching for `t` warns NO_I18NEXT_INSTANCE and
// silently falls back. Assertions here match stub-provided names, not
// translated copy, so returning the key is the honest substitute.
export const mockReactI18next = {
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
};

export const mockTauriCore = {
  invoke: (...args: unknown[]) => invokeMock(...args),
};

// TitleBar's win/linux branch calls `getCurrentWindow()` from
// @tauri-apps/api/window during mount to track maximize state. happy-dom has
// no Tauri internals so the call would throw — stub the bits TitleBar
// actually touches with no-op promises.
export const mockTauriWindow = {
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
};

export const mockTrayController = {
  listenTrayShowLedPreview: () => Promise.resolve(() => {}),
};

export const mockTrayApi = {
  updateTrayLabels: () => Promise.resolve(),
};

// useAutoUpdater wires `@tauri-apps/plugin-updater`'s `check()` to the
// global invoke mock; without an explicit stub the auto-updater check
// resolves to `{ connected: false }` (the default invokeMock value),
// which `useAutoUpdater` interprets as "update available" and renders
// the UpdateModal mid-test. The modal is not under test in most of these
// files — stub the hook to a state each test sets, re-rendered on demand.
export const mockAutoUpdater = {
  useAutoUpdater: () => {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    env.rerenderUpdater = rerender;
    return {
      state: env.updaterState,
      isModalOpen: env.updaterState.status !== "idle",
      channel: "stable",
      checkForUpdates: checkForUpdatesMock,
      checkForUpdatesInBackground: checkForUpdatesInBackgroundMock,
      checkFailedNotice: env.checkFailedNotice,
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn(),
      devSetState: vi.fn(),
    };
  },
};

export const mockWindowLifecycle = {
  loadShellState: () => loadShellStateMock(),
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
  initWindowLifecycle: () => initWindowLifecycleMock(),
  onShellStateSaved: () => () => {},
  resizeToMode: (mode: unknown) => resizeToModeMock(mode),
};

export const mockDeviceConnection = {
  useDeviceConnection: () => ({
    isConnected: env.isConnected,
    connectedPort: env.isConnected ? "/dev/cu.usbserial-test" : null,
    ports: [],
  }),
};

// Not a convenience stub. Both hooks read shell state through
// `shellStore.load()`, which *is* the mocked `windowLifecycle.loadShellState`,
// so leaving them real gives every scenario's `mockResolvedValueOnce` a second
// consumer racing App's bootstrap — the loser silently falls through to the
// beforeEach default and the persisted targets under test disappear.
export const mockWledSink = {
  useWledSinkRestore: () => undefined,
  useActiveWledSink: () => ({
    activeWledIp: env.activeWledIp,
    savedSink: null,
    restoreOutcome: null,
    ready: true,
    markConnected: async () => undefined,
  }),
};

export const mockEntryFlow = {
  shouldPromptLedSetupOnConnection: () => false,
  startCalibrationFromSettings: () => ({ open: true, step: "editor" }),
};

export const mockModeGuard = {
  MODE_GUARD_REASONS: {
    CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
  },
  canEnableLedMode: () => ({ canEnable: true, reason: null }),
};

export const mockModeApi = {
  applyOutputs: (request: ApplyOutputsRequest) => applyOutputsMock(request),
  retuneLighting: (tuning: unknown) => retuneLightingMock(tuning),
  releaseHueOutput: (trigger: string) => releaseHueOutputMock(trigger),
  getLightingRuntime: () => getLightingRuntimeMock(),
  startHue: vi.fn(),
  restartHue: vi.fn(),
  acquireHueForTest: vi.fn(),
  releaseHueAfterTest: vi.fn(),
};

export const mockLightingRuntimeEvents = {
  listenLightingRuntime: (listener: (snapshot: LightingRuntimeSnapshot) => void) => {
    env.publishRuntime = listener;
    return Promise.resolve(() => {});
  },
};

export const mockRuntimeHealthEvents = {
  listenRuntimeHealth: (listener: (health: RuntimeHealth) => void) => {
    env.pushHealth = listener;
    return Promise.resolve(() => {});
  },
};

// StatusBar renders useRuntimeTelemetry which polls `get_runtime_telemetry`
// via invokeMock. Stubbing the entire StatusBar component is the cleanest
// isolation boundary. The stub still renders each chip's value, which App
// derives and which is under test here; the telemetry-polling FPS pill is not.
export const mockStatusBar = {
  StatusBar: ({ items }: { items: Array<{ label: string; state: string }> }) => {
    env.statusBarRenders += 1;
    return (
      <ul>
        {items.map((item) => (
          <li key={item.label} data-testid={`status-chip-${item.label}`}>
            {item.state}
          </li>
        ))}
      </ul>
    );
  },
  statusBarHeightPx: () => 24,
  STATUS_BAR_HEIGHT_FULL_PX: 24,
  STATUS_BAR_HEIGHT_COMPACT_PX: 22,
};

const selectEverything = <T,>(state: T) => state;

/** Reads the stores as the real sections do, and exposes the actions as buttons. */
function LayoutProbe() {
  env.layoutProbeRenders += 1;
  const lighting = useLightingControlState(selectEverything);
  const hueStreaming = useHueShellStatus((status) => status.streaming);
  const hueReconnecting = useHueShellStatus((status) => status.reconnecting);
  const actions = useLightingActions();
  const activeSection = useNavigationState((state) => state.activeSection);
  const uiMode = useNavigationState((state) => state.uiMode);
  const deviceCategory = useNavigationState((state) => state.deviceCategoryRequest?.category ?? "");
  const registerLeaveGuard = useLeaveGuardRegistrar();
  env.lastLightingActions = actions;
  return (
    <div>
      <p data-testid="active-mode">{lighting.lightingMode.kind}</p>
      <p data-testid="active-section">{activeSection}</p>
      <p data-testid="ui-mode">{uiMode}</p>
      <p data-testid="device-category">{deviceCategory}</p>
      <p data-testid="hue-shown-state">
        {hueReconnecting ? "reconnecting" : hueStreaming ? "streaming" : "none"}
      </p>
      <p data-testid="output-targets">{lighting.outputTargets.join(",")}</p>
      <p data-testid="transitioning">{String(lighting.isModeTransitioning)}</p>
      <p data-testid="local-sink">
        {lighting.localSink ? `${lighting.localSink.transport}:${lighting.localSink.id}` : "none"}
      </p>
      <p data-testid="calibration-leds">{lighting.calibration?.totalLeds ?? ""}</p>
      <button type="button" onClick={() => actions.changeOutputTargets(["hue"])}>
        set-hue-target
      </button>
      <button
        type="button"
        onClick={() =>
          registerLeaveGuard((proceed) => {
            env.heldLeave = proceed;
            return true;
          })
        }
      >
        hold-leave
      </button>
      <button type="button" onClick={() => actions.changeOutputTargets(["usb", "hue"])}>
        set-both-targets
      </button>
      {/* The Devices Hue card's Stop retrying / Retry stop. */}
      <button type="button" onClick={() => void actions.stopHueOutput("device_surface")}>
        device-stop-hue
      </button>
      <button
        type="button"
        onClick={() =>
          actions.changeMode({
            kind: "solid",
            solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
          })
        }
      >
        set-solid
      </button>
      <button type="button" onClick={() => actions.changeMode({ kind: "off" })}>
        set-off
      </button>
      <button
        type="button"
        onClick={() =>
          actions.changeMode({
            kind: "ambilight",
            ambilight: { brightness: 0.8, saturation: 1, blackBorderDetection: false },
          })
        }
      >
        set-ambilight
      </button>
      {/* The same payload with its keys in another order, as a re-render rebuilds it. */}
      <button
        type="button"
        onClick={() =>
          actions.changeMode({
            kind: "ambilight",
            ambilight: { saturation: 1, blackBorderDetection: false, brightness: 0.8 },
          })
        }
      >
        set-ambilight-reordered
      </button>
    </div>
  );
}

// Memoised like the real one, so a render of it after mount means App handed
// it props, which it no longer takes.
export const mockSettingsLayout = {
  SettingsLayout: memo(function SettingsLayout(props: Record<string, unknown>) {
    env.layoutRenders += 1;
    env.lastLayoutProps = props;
    return <LayoutProbe />;
  }),
};

// ---------------------------------------------------------------------------
// The lighting backend: the runtime snapshot Rust publishes, and the replies of
// the transaction commands. Each test says what the next reply runs.
// ---------------------------------------------------------------------------

/** Serial status is the only per-test variable; every other command keeps the
 * shape its contract declares. Overriding invokeMock wholesale used to discard
 * those shapes, so callers reading `.status.code` fell into their own catch. */
export function installInvokeDispatch(serialConnected: boolean): void {
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY:
        return Promise.resolve({
          usb: {
            captureFps: 0,
            sendFps: 0,
            queueHealth: "Idle",
            frameLatencyMs: 0,
            linkConstrained: false,
            linkMaxFps: 0,
            lastCaptureErrorCode: null,
            lastCaptureErrorAtSecs: null,
          },
          hue: null,
        });
      default:
        return Promise.resolve({ connected: serialConnected });
    }
  });
}

/** A fresh revision every time, whatever `overrides` carries over. */
export function snapshot(overrides: Partial<LightingRuntimeSnapshot> = {}): LightingRuntimeSnapshot {
  env.revision += 1;
  return {
    mode: { kind: "off" },
    active: false,
    activeTargets: [],
    selectedTargets: ["usb"],
    phase: "idle",
    requestId: null,
    hueHeldOutReason: null,
    bootHueRetry: null,
    ...overrides,
    revision: env.revision,
  };
}

/** Rust publishes a new snapshot to every window. */
export function publish(overrides: Partial<LightingRuntimeSnapshot>): LightingRuntimeSnapshot {
  env.runtime = snapshot({ ...env.runtime, ...overrides });
  act(() => {
    env.publishRuntime?.(env.runtime);
  });
  return env.runtime;
}

export function reply(
  code: string,
  snap: LightingRuntimeSnapshot,
  outcome: Partial<ApplyOutputsOutcome> = {},
): ApplyOutputsResult {
  return {
    status: { code: code as ApplyOutputsResult["status"]["code"], message: "", details: null },
    requestId: 1,
    snapshot: snap,
    outcome: {
      hueStartCode: null,
      hueLeftOut: null,
      applyStatus: null,
      stopFailed: [],
      droppedTargets: [],
      modeEnded: false,
      ...outcome,
    },
  };
}

/** The next `apply_outputs` runs `overrides` and answers `code`. */
export function nextApplyRuns(
  overrides: Partial<LightingRuntimeSnapshot>,
  code = "OUTPUTS_APPLIED",
  outcome: Partial<ApplyOutputsOutcome> = {},
) {
  applyOutputsMock.mockImplementationOnce(() => {
    env.runtime = snapshot({ ...env.runtime, ...overrides });
    return Promise.resolve(reply(code, env.runtime, outcome));
  });
}

export const choices = () => applyOutputsMock.mock.calls.map(([request]) => request as ApplyOutputsRequest);
export const telemetryPolls = () =>
  invokeMock.mock.calls.filter(([command]) => command === DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY).length;
export const hueChip = () => screen.getByTestId("status-chip-HUE");
export const bootDone = () =>
  waitFor(() => expect(choices().some((request) => request.origin === "boot")).toBe(true));

/** Sets the mocked updater's state and re-renders its holder, as a progress event would. */
export function setUpdaterState(next: typeof env.updaterState): void {
  env.updaterState = next;
  act(() => {
    env.rerenderUpdater?.();
  });
}

export const CALIBRATION = {
  templateId: "monitor-27-16-9",
  counts: { top: 10, right: 10, bottom: 10, left: 10 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "subtle",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 40,
};

export const PAIRED = {
  lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
  hueAppKey: "app-user",
  hueClientKey: "AABBCCDD11223344",
  lastHueAreaId: "area-1",
};

/** The stream as the Hue health monitor reports it. */
export const hueStream = (state: "Running" | "Reconnecting" | "Failed" | "Idle") => ({
  stream: { active: state === "Running" || state === "Reconnecting", status: runtimeStatus(state) },
});

/** The shared beforeEach, after `vi.clearAllMocks()`. */
export function resetAppHarness(): void {
  vi.useRealTimers();
  env.isConnected = true;
  env.activeWledIp = null;
  env.updaterState = { status: "idle" };
  env.checkFailedNotice = null;
  env.rerenderUpdater = null;
  env.publishRuntime = null;
  env.pushHealth = null;
  env.lastLayoutProps = {};
  env.lastLightingActions = null;
  env.layoutRenders = 0;
  env.layoutProbeRenders = 0;
  env.statusBarRenders = 0;
  env.revision = 0;
  env.heldLeave = null;
  env.runtime = snapshot();
  installInvokeDispatch(true);
  getLightingRuntimeMock.mockImplementation(() => Promise.resolve(env.runtime));
  applyOutputsMock.mockImplementation(() => Promise.resolve(reply("OUTPUTS_APPLIED", env.runtime)));
  retuneLightingMock.mockResolvedValue({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
  releaseHueOutputMock.mockImplementation(() => Promise.resolve(reply("OUTPUTS_APPLIED", env.runtime)));
  loadShellStateMock.mockResolvedValue({
    lastSection: "general",
    ledCalibration: CALIBRATION,
    lightingMode: {
      kind: "solid",
      solid: { r: 1, g: 2, b: 3, brightness: 0.5 },
    },
  });
  initWindowLifecycleMock.mockResolvedValue(undefined);
  resizeToModeMock.mockResolvedValue(undefined);
  saveShellStateMock.mockResolvedValue(undefined);
}
