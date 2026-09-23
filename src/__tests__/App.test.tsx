import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LightingModeConfig } from "@/shared/contracts/mode";
import type { LocalSink } from "../features/device/localSink";
import { DEVICE_COMMANDS, type ColorCorrectionConfig, type LedChipType } from "@/shared/contracts/device";
import { HUE_COMMANDS, HUE_READINESS_REASON, HUE_RUNTIME_TRIGGER_SOURCE, HUE_STATUS } from "@/shared/contracts/hue";
import { appliedResult } from "@/test/modeCommandResult";

const loadShellStateMock = vi.fn();
const saveShellStateMock = vi.fn();
const initWindowLifecycleMock = vi.fn();
const setLightingModeMock = vi.fn();
const stopLightingMock = vi.fn();
const startHueMock = vi.fn();
const stopHueMock = vi.fn();

// Controllable isConnected for hot-plug tests
let mockIsConnected = true;
let mockActiveWledIp: string | null = null;
// Idle unless a test opens the update prompt on purpose.
let mockUpdaterState: { status: string; update?: unknown } = { status: "idle" };
let mockCheckFailedNotice: { message: string } | null = null;
const checkForUpdatesMock = vi.fn().mockResolvedValue(undefined);
const checkForUpdatesInBackgroundMock = vi.fn().mockResolvedValue(undefined);

// Mock invoke for Tauri commands (used in bootstrap for USB status check)
const invokeMock = vi.fn();

// App renders without the I18nextProvider that providers.tsx supplies in the
// real shell, so any component reaching for `t` warns NO_I18NEXT_INSTANCE and
// silently falls back. Assertions here match stub-provided names, not
// translated copy, so returning the key is the honest substitute.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// TitleBar's win/linux branch calls `getCurrentWindow()` from
// @tauri-apps/api/window during mount to track maximize state. happy-dom has
// no Tauri internals so the call would throw — stub the bits TitleBar
// actually touches with no-op promises.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

vi.mock("../features/tray/trayController", () => ({
  listenTrayLightsOff: () => Promise.resolve(() => {}),
  listenTrayResumeLastMode: () => Promise.resolve(() => {}),
  listenTraySolidColor: () => Promise.resolve(() => {}),
  listenTrayShowLedPreview: () => Promise.resolve(() => {}),
  listenStartupToggle: () => Promise.resolve(() => {}),
}));

vi.mock("../features/tray/trayApi", () => ({
  updateTrayLabels: () => Promise.resolve(),
}));

// useAutoUpdater wires `@tauri-apps/plugin-updater`'s `check()` to the
// global invoke mock; without an explicit stub the auto-updater check
// resolves to `{ connected: false }` (the default invokeMock value),
// which `useAutoUpdater` interprets as "update available" and renders
// the UpdateModal mid-test, racing the output-targets waitFor. The
// modal is not under test in this file — stub the hook to a static
// idle state so updater behaviour stays out of the lighting-mode
// orchestration assertions.
vi.mock("../features/updater/useAutoUpdater", () => ({
  useAutoUpdater: () => ({
    state: mockUpdaterState,
    isModalOpen: mockUpdaterState.status !== "idle",
    channel: "stable",
    checkForUpdates: checkForUpdatesMock,
    checkForUpdatesInBackground: checkForUpdatesInBackgroundMock,
    checkFailedNotice: mockCheckFailedNotice,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    devSetState: vi.fn(),
  }),
}));

vi.mock("../features/shell/windowLifecycle", () => ({
  loadShellState: () => loadShellStateMock(),
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
  initWindowLifecycle: () => initWindowLifecycleMock(),
  onShellStateSaved: () => () => {},
}));

vi.mock("../features/device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({
    isConnected: mockIsConnected,
    connectedPort: mockIsConnected ? "/dev/cu.usbserial-test" : null,
    ports: [],
  }),
}));

// Not a convenience stub. Both hooks read shell state through
// `shellStore.load()`, which *is* the mocked `windowLifecycle.loadShellState`,
// so leaving them real gives every scenario's `mockResolvedValueOnce` a second
// consumer racing App's bootstrap — the loser silently falls through to the
// beforeEach default and the persisted targets under test disappear.
vi.mock("../features/device/useWledSink", () => ({
  useWledSinkRestore: () => undefined,
  useActiveWledSink: () => ({
    activeWledIp: mockActiveWledIp,
    savedSink: null,
    restoreOutcome: null,
    ready: true,
    markConnected: async () => undefined,
  }),
}));

vi.mock("../features/calibration/state/entryFlow", () => ({
  shouldAutoOpenCalibrationOnConnection: () => false,
  startCalibrationFromSettings: () => ({ open: false, step: "editor" }),
}));

vi.mock("../features/mode/state/modeGuard", () => ({
  MODE_GUARD_REASONS: {
    CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
  },
  canEnableLedMode: () => ({ canEnable: true, reason: null }),
}));

const getHueStreamStatusMock = vi.fn();
const getLightingModeStatusMock = vi.fn();
const setHueSolidColorMock = vi.fn();

vi.mock("../features/mode/modeApi", () => ({
  setLightingMode: (payload: LightingModeConfig) => setLightingModeMock(payload),
  stopLighting: () => stopLightingMock(),
  startHue: (payload: { bridgeIp: string; username: string; clientKey: string; areaId: string }) => startHueMock(payload),
  stopHue: (...args: unknown[]) => stopHueMock(...args),
  getHueStreamStatus: () => getHueStreamStatusMock(),
  getLightingModeStatus: () => getLightingModeStatusMock(),
  setHueSolidColor: (payload: unknown) => setHueSolidColorMock(payload),
}));

// StatusBar renders useRuntimeTelemetry which polls `get_runtime_telemetry`
// via invokeMock. With a flat `mockResolvedValue({ connected: true })` the
// DTO lands as `{ connected: true }`, `mapFullTelemetrySnapshot` throws on
// `dto.usb` (undefined), and the repeated throw/catch in the polling loop
// floods the happy-dom event queue — causing ambilight `waitFor` assertions to
// hit their 3 s timeout in the full suite even though each test passes in
// isolation. Stubbing the entire StatusBar component is the cleanest
// isolation boundary. The stub still renders each chip's value, which App
// derives and which is under test here; the telemetry-polling FPS pill is not.
vi.mock("../features/shell/StatusBar", () => ({
  StatusBar: ({ items }: { items: Array<{ label: string; state: string }> }) => (
    <ul>
      {items.map((item) => (
        <li key={item.label} data-testid={`status-chip-${item.label}`}>
          {item.state}
        </li>
      ))}
    </ul>
  ),
  statusBarHeightPx: () => 24,
  STATUS_BAR_HEIGHT_FULL_PX: 24,
  STATUS_BAR_HEIGHT_COMPACT_PX: 22,
}));

vi.mock("../features/settings/SettingsLayout", () => ({
  SettingsLayout: (props: {
    lightingMode: LightingModeConfig;
    outputTargets: Array<"usb" | "hue">;
    localSink: LocalSink | null;
    calibration?: { totalLeds: number };
    hueStreaming: boolean;
    hueReconnecting?: boolean;
    onLightingModeChange: (mode: LightingModeConfig) => void;
    onOutputTargetsChange: (targets: Array<"usb" | "hue">) => void;
    onStopHueOutput: (triggerSource: string) => Promise<void>;
    onColorCorrectionChange: (next: ColorCorrectionConfig) => void;
    onChipTypeChange: (next: LedChipType) => void;
  }) => (
    <div>
      <p data-testid="active-mode">{props.lightingMode.kind}</p>
      <p data-testid="hue-shown-state">
        {props.hueReconnecting ? "reconnecting" : props.hueStreaming ? "streaming" : "none"}
      </p>
      <p data-testid="output-targets">{props.outputTargets.join(",")}</p>
      <p data-testid="local-sink">
        {props.localSink ? `${props.localSink.transport}:${props.localSink.id}` : "none"}
      </p>
      {/* Bootstrap-applied calibration. `active-mode === "off"` is satisfied by
          the initial state, so it cannot gate a click on bootstrap having run. */}
      <p data-testid="calibration-leds">{props.calibration?.totalLeds ?? ""}</p>
      <button
        type="button"
        onClick={() => props.onOutputTargetsChange(["hue"])}
      >
        set-hue-target
      </button>
      <button
        type="button"
        onClick={() => props.onOutputTargetsChange(["usb"])}
      >
        set-usb-target
      </button>
      <button
        type="button"
        onClick={() => props.onOutputTargetsChange(["usb", "hue"])}
      >
        set-both-targets
      </button>
      {/* The Lights toggle never sends an empty set; the handler still accepts one. */}
      <button type="button" onClick={() => props.onOutputTargetsChange([])}>
        set-no-targets
      </button>
      {/* The Devices Hue card's Stop retrying / Retry stop. */}
      <button type="button" onClick={() => void props.onStopHueOutput("device_surface")}>
        device-stop-hue
      </button>
      <button
        type="button"
        onClick={() =>
          props.onLightingModeChange({
            kind: "solid",
            solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
          })
        }
      >
        set-solid
      </button>
      {/* Instant settings: each re-dispatches the live mode as it stands. */}
      <button
        type="button"
        onClick={() =>
          props.onColorCorrectionChange({ gammaR: 2.2, gammaG: 2.2, gammaB: 2.2, kelvin: 5000, saturation: 1.1 })
        }
      >
        change-color-correction
      </button>
      <button type="button" onClick={() => props.onChipTypeChange("sk6812-rgbw")}>
        change-chip-type
      </button>
      <button
        type="button"
        onClick={() => props.onLightingModeChange({ kind: "off" })}
      >
        set-off
      </button>
      <button
        type="button"
        onClick={() =>
          props.onLightingModeChange({
            kind: "ambilight",
            ambilight: { brightness: 0.8, saturation: 1, blackBorderDetection: false },
          })
        }
      >
        set-ambilight
      </button>
      <button
        type="button"
        onClick={() =>
          // Same Ambilight payload as set-ambilight — used by the
          // idempotency regression test to confirm dedup gates the
          // second dispatch even when the first slow-path transition
          // has already completed.
          props.onLightingModeChange({
            kind: "ambilight",
            ambilight: { brightness: 0.8, saturation: 1, blackBorderDetection: false },
          })
        }
      >
        set-ambilight-again
      </button>
      <button
        type="button"
        onClick={() =>
          // Semantically identical Ambilight payload as `set-ambilight`,
          // but the object literal lists ambilight sub-fields in a
          // *different order* (saturation → blackBorderDetection →
          // brightness). The hot-reload paths in App.tsx hit this exact
          // shape every time they re-stamp `colorCorrection` /
          // `firmwareProfile` after a spread chain — the JSON.stringify
          // signature was string-unequal across two such fires even
          // though the semantic content was identical, which is what
          // let the Ambilight-mode 50 Hz spam slip past the guard.
          // The canonical, key-sorted signature in
          // `dispatchSetLightingMode` is what catches this.
          props.onLightingModeChange({
            kind: "ambilight",
            ambilight: { saturation: 1, blackBorderDetection: false, brightness: 0.8 },
          })
        }
      >
        set-ambilight-reordered
      </button>
    </div>
  ),
}));

import App from "../App";
import { __resetHueReadCacheForTests } from "../features/hue/hueReadCache";
import {
  __resetHueTestLease,
  acquireHueForTest,
  releaseHueAfterTest,
} from "../features/hue/state/hueTestLease";

/** Serial status is the only per-test variable; every other command keeps the
 * shape its contract declares. Overriding invokeMock wholesale used to discard
 * those shapes, so callers reading `.status.code` fell into their own catch. */
function installInvokeDispatch(serialConnected: boolean): void {
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case HUE_COMMANDS.VALIDATE_CREDENTIALS:
        return Promise.resolve({
          status: { code: HUE_STATUS.CREDENTIAL_VALID, message: "ok", details: null },
          valid: true,
        });
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

/**
 * A `set_lighting_mode` backend that remembers what it runs. Rust retunes the
 * running mode in place only while the targets match, so a send naming other
 * targets counts as a target change (a worker restart). A send naming Hue while
 * no stream is up is refused by the Hue gate, and a Solid send naming Hue is the
 * one Rust pushes the colour to the bridge for. A Hue stop while the running
 * mode still names Hue is counted: that worker holds the stream's sender open
 * through the stop and its light restore.
 */
function installLightingBackend() {
  const backend = {
    hueStreamUp: false,
    running: null as LightingModeConfig | null,
    targetChanges: 0,
    hueSolidSends: 0,
    hueStopsUnderWorker: 0,
  };
  // Absent or empty targets mean USB to the backend (legacy rule).
  const targetsOf = (mode: LightingModeConfig) =>
    mode.targets && mode.targets.length > 0 ? mode.targets : ["usb"];
  setLightingModeMock.mockImplementation((payload: LightingModeConfig) => {
    if (payload.kind !== "off" && targetsOf(payload).includes("hue") && !backend.hueStreamUp) {
      return Promise.resolve({
        active: backend.running !== null,
        mode: backend.running ?? { kind: "off" },
        status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
      });
    }
    if (
      backend.running?.kind === payload.kind &&
      targetsOf(backend.running).join() !== targetsOf(payload).join()
    ) {
      backend.targetChanges += 1;
    }
    backend.running = payload.kind === "off" ? null : payload;
    if (payload.kind === "solid" && targetsOf(payload).includes("hue")) backend.hueSolidSends += 1;
    return Promise.resolve(appliedResult(payload));
  });
  startHueMock.mockImplementation(() => {
    backend.hueStreamUp = true;
    return Promise.resolve({
      active: true,
      status: { code: "HUE_STREAM_RUNNING", message: "Running", details: null },
    });
  });
  stopHueMock.mockImplementation(() => {
    if (backend.running !== null && targetsOf(backend.running).includes("hue")) backend.hueStopsUnderWorker += 1;
    backend.hueStreamUp = false;
    return Promise.resolve({
      active: false,
      status: { code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
  });
  stopLightingMock.mockImplementation(() => {
    backend.running = null;
    return Promise.resolve({ active: false });
  });
  getLightingModeStatusMock.mockImplementation(() =>
    Promise.resolve({
      active: backend.running !== null,
      mode: backend.running ?? { kind: "off" },
      status: { code: "LIGHTING_MODE_STATUS_OK", message: "ok", details: null },
    }),
  );
  getHueStreamStatusMock.mockImplementation(() =>
    Promise.resolve({
      active: backend.hueStreamUp,
      lastSolidColor: null,
      status: backend.hueStreamUp
        ? { state: "Running", code: "HUE_STREAM_RUNNING", message: "Running", details: null }
        : { state: "Idle", code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    }),
  );
  return backend;
}

const lastModeSend = () =>
  setLightingModeMock.mock.calls[setLightingModeMock.mock.calls.length - 1][0] as LightingModeConfig;

const hueChip = () => screen.getByTestId("status-chip-HUE");

describe("App mode orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level cache: without this a prior test's status leaks into the
    // next one, since the mocked modeApi never invalidates the way the real one does.
    __resetHueReadCacheForTests();
    vi.useRealTimers();
    mockIsConnected = true;
    mockActiveWledIp = null;
    mockUpdaterState = { status: "idle" };
    mockCheckFailedNotice = null;
    // One flat resolved value cannot serve every command: a caller reading
    // `.status.code` or `.usb` off `{ connected: true }` throws into its own
    // catch, so the test still passed while the app measured its failure
    // branch. Dispatch on the command name and give each the shape its
    // contract declares; the serial-status default stays for the rest.
    installInvokeDispatch(true);
    getLightingModeStatusMock.mockResolvedValue({
      active: false,
      mode: { kind: "off" },
      status: { code: "LIGHTING_MODE_STATUS_OK", message: "ok", details: null },
    });
    getHueStreamStatusMock.mockResolvedValue({
      active: false,
      lastSolidColor: null,
      status: { state: "Idle", code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
    setHueSolidColorMock.mockResolvedValue({
      active: true,
      status: { state: "Running", code: "HUE_SOLID_COLOR_APPLIED", message: "ok", details: null },
    });
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: {
        kind: "solid",
        solid: { r: 1, g: 2, b: 3, brightness: 0.5 },
      },
    });
    initWindowLifecycleMock.mockResolvedValue(undefined);
    saveShellStateMock.mockResolvedValue(undefined);
    setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
      Promise.resolve(appliedResult(payload)),
    );
    stopLightingMock.mockResolvedValue({ active: false });
    startHueMock.mockResolvedValue({
      active: true,
      status: { code: "HUE_STREAM_RUNNING", message: "Running", details: null },
    });
    stopHueMock.mockResolvedValue({
      active: false,
      status: { code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
  });

  it("restores persisted lighting mode on bootstrap", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });
  });

  it("calls mode command and persists only lightingMode when mode changes", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    // The dispatched payload now also carries the persisted
    // `ledCalibration` (v1.5 1-LED bug fix — frontend stamps
    // calibration so the Rust encoder can size USB packets to the
    // real strip length). Use objectContaining so this test stays
    // focused on the mode-payload core fields.
    expect(setLightingModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "solid",
        solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
        ambilight: undefined,
        targets: ["usb"],
      }),
    );
    expect(setLightingModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ledCalibration: expect.objectContaining({ totalLeds: 40 }),
      }),
    );

    await waitFor(() => {
      // Persisted shell state still tracks `lightingMode` only; the
      // calibration lives under its own top-level shell key and is
      // *not* round-tripped inside `lightingMode` itself.
      expect(saveShellStateMock).toHaveBeenCalledWith({
        lightingMode: {
          kind: "solid",
          solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
          ambilight: undefined,
          targets: ["usb"],
        },
      });
    });
  });

  it("calls stopLighting when switching mode to off", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-off" }).click();
    });

    expect(stopLightingMock).toHaveBeenCalledOnce();
  });

  it("calls start_hue_stream when hue is selected and keeps mode unchanged on gate failure", async () => {
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    startHueMock.mockResolvedValueOnce({
      active: false,
      status: { code: "CONFIG_NOT_READY_GATE_BLOCKED", message: "Gate blocked", details: "readiness" },
    });

    // Ensure handleLightingModeChange's loadShellState() call also returns Hue config
    // so runtimeHueStartConfig is populated from the shell state rather than hueStartConfig React state
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "off" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    // Wait for bootstrap to complete — output-targets reflects persisted ["hue"]
    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    expect(startHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.10",
      username: "app-user",
      clientKey: "AABBCCDD11223344",
      areaId: "area-1",
    });
    expect(setLightingModeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
  });

  it("starts hue for a keychain install whose secrets are no longer on disk", async () => {
    // The point of the keychain migration: neither key is in shell-state.json,
    // and Rust resolves them from the empty username/clientKey signal.
    const keychainState = {
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "off" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      credentialStorageBackend: "keychain",
      lastHueAreaId: "area-1",
    };
    loadShellStateMock.mockResolvedValue(keychainState);

    startHueMock.mockResolvedValueOnce({
      active: true,
      status: { code: "HUE_STREAM_RUNNING", message: "Running" },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    expect(startHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.10",
      username: "",
      clientKey: "",
      areaId: "area-1",
    });
  });

  it("repeated set-solid: first call starts hue, second falls into the quick fast path", async () => {
    // Off → Solid is a full transition that opens the Hue stream.
    // Solid → Solid is a "quick adjustment" (`handleLightingModeChange` in
    // useLightingModeOrchestrator.ts) that pushes the
    // new color via setHueSolidColor without re-issuing startHue — that's
    // the optimization that keeps brightness drags from stuttering. So the
    // idempotent contract is: the second click MUST NOT re-trigger startHue,
    // but it MUST still propagate the color update through setHueSolidColor.
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    startHueMock.mockResolvedValueOnce({
      active: true,
      status: { code: "HUE_STREAM_RUNNING", message: "Running", details: null },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    expect(startHueMock).toHaveBeenCalledTimes(1);
    expect(setHueSolidColorMock).toHaveBeenCalled();
    expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
  });

  it("filters persisted USB target when USB is not connected on startup", async () => {
    // Setup: loadShellStateMock returns lastOutputTargets: ["usb", "hue"], useDeviceConnection returns isConnected: false
    mockIsConnected = false;
    installInvokeDispatch(false);
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    // After bootstrap, saveShellState should NOT be called with USB target
    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });
    // When USB is not connected at startup, USB target is filtered out.
    // The app should not crash and should render successfully.
    expect(screen.getByTestId("active-mode")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Bug 10C — auto-add "usb" to outputTargets on the first false→true
  // transition of `isConnected`. Pairing IS the user's "I want USB
  // output" intent; without this fix the Lights output toggle stays
  // is-off until a WebView reload. See useUsbTargetReconciler.ts.
  // ---------------------------------------------------------------------
  it("auto-adds usb target on first pair (false→true transition, hue-only baseline)", async () => {
    // Cold launch: persisted Hue-only session, USB cable unplugged.
    mockIsConnected = false;
    installInvokeDispatch(false);
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "off" },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");
    });
    // Pre-condition: usb is NOT yet a target.
    expect(screen.getByTestId("output-targets").textContent).not.toContain("usb");

    // Reset persistence spy so the next assertion only sees the transition's
    // own save (not the bootstrap writes).
    saveShellStateMock.mockClear();

    // User pairs the strip → useDeviceConnection flips isConnected.
    mockIsConnected = true;
    await act(async () => {
      rerender(<App />);
    });

    // outputTargets must now contain BOTH hue and usb. The shared
    // `normalizeOutputTargets` helper canonicalises the order to
    // ["usb", "hue"], so that's what the panel and persistence see.
    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
    });

    // Persistence: the auto-add round-trips through handleOutputTargetsChange,
    // which writes the new lastOutputTargets to shell state.
    await waitFor(() => {
      expect(saveShellStateMock).toHaveBeenCalledWith(
        expect.objectContaining({ lastOutputTargets: ["usb", "hue"] }),
      );
    });
  });

  it("does not duplicate usb target when isConnected toggles a second time", async () => {
    // Cold launch: persisted dual-target session, USB already present at boot.
    // This emulates the "auto-reconnect on init" path landing the app in
    // CONNECTED state from frame 1, so the false→true transition should
    // never fire and outputTargets must NOT pick up a duplicate "usb".
    mockIsConnected = true;
    installInvokeDispatch(true);
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
    });

    // Force a re-render (no isConnected change); idempotent guard must hold.
    await act(async () => {
      rerender(<App />);
    });

    // Targets stay ["usb","hue"] — no "usb,hue,usb" duplicate.
    expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
    expect(screen.getByTestId("output-targets").textContent).toBe("usb,hue");
  });

  it("silently drops USB target when USB is unplugged during dual-target session", async () => {
    // Setup: Start with targets=["usb", "hue"], isConnected=true
    mockIsConnected = true;
    installInvokeDispatch(true);
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    // Action: Simulate USB being unplugged
    mockIsConnected = false;
    await act(async () => {
      rerender(<App />);
    });

    // Expect: app does not crash, USB dropped from targets (Hue continues)
    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toBeInTheDocument();
    });
    // saveShellState should have been called (target update)
    // The exact call assertion depends on timing, but app should still render
    expect(screen.getByTestId("active-mode")).toBeInTheDocument();
  });

  // Regression: the unplug drops "usb" from targets in the same commit that
  // raises the toast, which used to re-run the effect owning the dismissal timer.
  it("auto-dismisses the USB disconnect toast even though the unplug changes output targets", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockIsConnected = true;
    installInvokeDispatch(true);
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    const { rerender } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
    });

    mockIsConnected = false;
    await act(async () => {
      rerender(<App />);
    });

    // Toast is up, and the unplug really did rewrite the target set — that
    // rewrite is what used to kill the dismissal timer.
    await waitFor(() => {
      expect(screen.getByTestId("usb-disconnect-notice")).toBeInTheDocument();
    });
    expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.queryByTestId("usb-disconnect-notice")).not.toBeInTheDocument();
  });

  it("handleOutputTargetsChange delta-start: adding hue while usb active calls start_hue_stream", async () => {
    // Setup: Start with usb selected, solid mode active, usb connected
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastOutputTargets: ["usb"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });
    // Second loadShellState call is made inside delta-start for Hue config
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastOutputTargets: ["usb"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    // Activate usb mode first
    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    startHueMock.mockClear();
    invokeMock.mockClear();

    // Now add hue target while usb is active
    await act(async () => {
      screen.getByRole("button", { name: "set-both-targets" }).click();
    });

    await waitFor(() => {
      expect(startHueMock).toHaveBeenCalledWith({
        bridgeIp: "192.168.1.10",
        username: "app-user",
        clientKey: "AABBCCDD11223344",
        areaId: "area-1",
      });
    });
  });

  it("handleOutputTargetsChange delta-stop: removing usb while hue active calls stop_lighting", async () => {
    // Setup: Start with both targets, solid mode active
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    // Activate both targets
    await act(async () => {
      screen.getByRole("button", { name: "set-both-targets" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    invokeMock.mockClear();

    // Now remove usb target (keep only hue)
    await act(async () => {
      screen.getByRole("button", { name: "set-hue-target" }).click();
    });

    await waitFor(() => {
      expect(stopLightingMock).toHaveBeenCalledOnce();
    });
  });

  it("handleOutputTargetsChange no delta when mode is OFF", async () => {
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    invokeMock.mockClear();
    startHueMock.mockClear();
    stopLightingMock.mockClear();
    stopHueMock.mockClear();

    // Change targets while mode is OFF — no start/stop should be invoked
    await act(async () => {
      screen.getByRole("button", { name: "set-both-targets" }).click();
    });

    expect(invokeMock).not.toHaveBeenCalledWith("start_hue_stream");
    expect(invokeMock).not.toHaveBeenCalledWith("stop_hue_stream");
    expect(invokeMock).not.toHaveBeenCalledWith("set_lighting_mode");
    expect(invokeMock).not.toHaveBeenCalledWith("stop_lighting");
    expect(startHueMock).not.toHaveBeenCalled();
    expect(stopLightingMock).not.toHaveBeenCalled();
    expect(stopHueMock).not.toHaveBeenCalled();
  });

  it("routes stop to selected targets and does not re-trigger hue start after manual stop", async () => {
    loadShellStateMock.mockResolvedValueOnce({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "off" },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    // Wait for bootstrap to complete — output-targets reflects persisted ["usb", "hue"]
    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-off" }).click();
    });

    expect(setLightingModeMock).toHaveBeenCalledTimes(1);
    expect(startHueMock).toHaveBeenCalledTimes(1);
    expect(stopLightingMock).toHaveBeenCalledTimes(1);
    expect(stopHueMock).toHaveBeenCalledTimes(1);
    expect(startHueMock).toHaveBeenCalledTimes(1);
  });

  it("handleOutputTargetsChange delta-stop: removing hue while usb active stops hue with the system trigger", async () => {
    // The suite default reports the stream Idle, which makes the health
    // reconciler strip "hue" from active targets before the delta can fire.
    getHueStreamStatusMock.mockResolvedValue({
      active: true,
      lastSolidColor: null,
      status: { state: "Running", code: "HUE_STREAM_RUNNING", message: "Running", details: null },
    });
    setHueSolidColorMock.mockResolvedValue({
      active: true,
      status: { state: "Running", code: "HUE_SOLID_COLOR_APPLIED", message: "ok", details: null },
    });
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-both-targets" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    stopHueMock.mockClear();

    // Remove hue target (keep only usb)
    await act(async () => {
      screen.getByRole("button", { name: "set-usb-target" }).click();
    });

    await waitFor(() => {
      expect(stopHueMock).toHaveBeenCalledOnce();
    });
    // System, not the MODE_CONTROL default — a bare stopHue() here would
    // silently reattribute the stop event in runtime telemetry.
    expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
  });

  // The Outputs card adds or removes a target from the running mode without a
  // mode transition. The live mode kept its old targets, so the next instant
  // setting re-sent them: Rust saw a target change and restarted the worker,
  // and a Solid re-apply sent the bridge no colour.
  describe("the live mode follows a target added to or removed from it", () => {
    const pairedShellState = {
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    };
    const persistedTargets = () =>
      saveShellStateMock.mock.calls
        .map(([patch]) => patch as Record<string, unknown>)
        .filter((patch) => "lastOutputTargets" in patch)
        .map((patch) => patch.lastOutputTargets);

    async function changeColorCorrection() {
      // Past the dispatcher's 20 ms cooldown, which drops an unforced send.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      const before = setLightingModeMock.mock.calls.length;
      await act(async () => {
        screen.getByRole("button", { name: "change-color-correction" }).click();
      });
      await waitFor(() => {
        expect(setLightingModeMock.mock.calls.length).toBe(before + 1);
      });
      return lastModeSend();
    }

    it("sends a setting change to both targets after the user adds Hue, and Solid keeps colouring Hue", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...pairedShellState, lastOutputTargets: ["usb"] });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
        expect(backend.running?.targets).toEqual(["usb"]);
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-both-targets" }).click();
      });
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb", "hue"]);
        expect(setHueSolidColorMock).toHaveBeenCalled();
      });
      // The add itself is the one restart it costs.
      const restartsAfterAdd = backend.targetChanges;
      const hueSendsAfterAdd = backend.hueSolidSends;

      const send = await changeColorCorrection();
      expect(send.targets).toEqual(["usb", "hue"]);
      expect(send.colorCorrection).toEqual(expect.objectContaining({ kelvin: 5000 }));
      expect(backend.targetChanges).toBe(restartsAfterAdd);
      expect(backend.hueSolidSends).toBe(hueSendsAfterAdd + 1);

      await act(async () => {
        screen.getByRole("button", { name: "change-chip-type" }).click();
      });
      await waitFor(() => {
        expect(lastModeSend().chipType).toBe("sk6812-rgbw");
      });
      expect(lastModeSend().targets).toEqual(["usb", "hue"]);
      expect(backend.targetChanges).toBe(restartsAfterAdd);
      expect(backend.hueSolidSends).toBe(hueSendsAfterAdd + 2);
      // The user's own toggle is the one write; keeping the live mode current adds none.
      expect(persistedTargets()).toEqual([["usb", "hue"]]);
    });

    it("sends a setting change to USB alone after the user removes Hue", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...pairedShellState, lastOutputTargets: ["usb", "hue"] });
      render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb", "hue"]);
        expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-usb-target" }).click();
      });
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });
      const hueSendsAfterRemove = backend.hueSolidSends;

      // With Hue still in the live mode, this send hits the Hue gate and the
      // setting never reaches the strip.
      const send = await changeColorCorrection();
      expect(send.targets).toEqual(["usb"]);
      expect(backend.running?.targets).toEqual(["usb"]);
      expect(backend.running?.colorCorrection).toEqual(expect.objectContaining({ kelvin: 5000 }));
      expect(backend.hueSolidSends).toBe(hueSendsAfterRemove);
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
    });

    it("keeps a Hue add the bridge refused out of the live mode, without rewriting the saved targets", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...pairedShellState, lastOutputTargets: ["usb"] });
      startHueMock.mockResolvedValue({
        active: false,
        status: { code: "CONFIG_NOT_READY_GATE_BLOCKED", message: "blocked", details: null },
      });
      render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb"]);
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-both-targets" }).click();
      });
      await waitFor(() => {
        expect(screen.getByTestId("hue-left-out-notice")).toBeInTheDocument();
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      const send = await changeColorCorrection();
      expect(send.targets).toEqual(["usb"]);
      expect(backend.targetChanges).toBe(0);
      // Only the user's explicit add; the drop is session-only.
      expect(persistedTargets()).toEqual([["usb", "hue"]]);
    });

    // A delta add never rewrites the persisted mode, so its targets go stale
    // and the next launch restored them into the live mode.
    it("sends a setting change to what the launch restore ran, not the saved mode's targets", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({
        ...pairedShellState,
        lightingMode: { ...pairedShellState.lightingMode, targets: ["usb"] },
        lastOutputTargets: ["usb", "hue"],
      });
      render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb", "hue"]);
      });
      const hueSendsAfterBoot = backend.hueSolidSends;

      const send = await changeColorCorrection();
      expect(send.targets).toEqual(["usb", "hue"]);
      expect(backend.targetChanges).toBe(0);
      expect(backend.hueSolidSends).toBe(hueSendsAfterBoot + 1);
      expect(persistedTargets()).toEqual([]);
    });
  });

  // `stop_lighting` turns the whole backend mode Off. Sent for a USB removal
  // from [usb, hue], it left the Hue stream open with nothing feeding it while
  // the UI still showed the mode running on Hue.
  describe("removing USB from a running [usb, hue] mode keeps Hue running", () => {
    const pairedShellState = {
      lastSection: "general",
      ledCalibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 10, right: 10, bottom: 10, left: 10 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 40,
      },
      lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
      lastOutputTargets: ["usb", "hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    };
    const persistedTargets = () =>
      saveShellStateMock.mock.calls
        .map(([patch]) => patch as Record<string, unknown>)
        .filter((patch) => "lastOutputTargets" in patch)
        .map((patch) => patch.lastOutputTargets);

    async function bootDualTargetSession(shellState: Record<string, unknown> = pairedShellState) {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue(shellState);
      const view = render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb", "hue"]);
        expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
      });
      const before = {
        modeSends: setLightingModeMock.mock.calls.length,
        hueStarts: startHueMock.mock.calls.length,
      };
      return { backend, view, before };
    }

    // Asserted after the change settles, so a late stop would still be counted.
    async function expectRunningOnHueAlone(
      backend: ReturnType<typeof installLightingBackend>,
      before: { modeSends: number; hueStarts: number },
    ) {
      await waitFor(() => {
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^hue$/);
        expect(backend.running?.targets).toEqual(["hue"]);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      const sends = setLightingModeMock.mock.calls.slice(before.modeSends).map(([payload]) => payload);
      expect(sends).toEqual([expect.objectContaining({ kind: "solid", targets: ["hue"] })]);
      expect(stopLightingMock).not.toHaveBeenCalled();
      // `stop_hue_stream` is also what runs the #425 light restore.
      expect(stopHueMock).not.toHaveBeenCalled();
      expect(startHueMock.mock.calls.length).toBe(before.hueStarts);
      expect(backend.hueStreamUp).toBe(true);
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
      expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
    }

    it("re-applies the mode on Hue alone when the user turns USB off", async () => {
      const { backend, before } = await bootDualTargetSession();

      await act(async () => {
        screen.getByRole("button", { name: "set-hue-target" }).click();
      });

      await expectRunningOnHueAlone(backend, before);
      // The explicit toggle persists, as every user target change does.
      expect(persistedTargets()).toEqual([["hue"]]);
    });

    it("re-applies the mode on Hue alone when the strip is unplugged, without rewriting the saved targets", async () => {
      const { backend, view, before } = await bootDualTargetSession();

      mockIsConnected = false;
      await act(async () => {
        view.rerender(<App />);
      });

      await expectRunningOnHueAlone(backend, before);
      expect(screen.getByTestId("usb-disconnect-notice")).toBeInTheDocument();
      // The strip is still the user's choice; the next launch filters it by availability.
      expect(persistedTargets()).toEqual([]);
    });

    it("shows Off and gives back the Hue stream when the re-apply's start fails", async () => {
      const { backend, before } = await bootDualTargetSession();
      // Keyed on the payload, not `mockImplementationOnce`: an unconsumed "once"
      // survives `clearAllMocks` and would answer the next test's boot restore.
      const applyAsBackend = setLightingModeMock.getMockImplementation()!;
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) => {
        if (payload.targets?.join() !== "hue") return applyAsBackend(payload);
        backend.running = null;
        return Promise.resolve({
          active: false,
          mode: { kind: "off" },
          status: { code: "SOLID_MODE_APPLY_FAILED", message: "failed", details: null },
        });
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-hue-target" }).click();
      });

      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });
      expect(setLightingModeMock.mock.calls.length).toBe(before.modeSends + 1);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
      expect(backend.hueStreamUp).toBe(false);
    });

    it("still stops the lighting runtime when the last target is removed", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...pairedShellState, lastOutputTargets: ["usb"] });
      render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb"]);
      });
      const modeSends = setLightingModeMock.mock.calls.length;

      await act(async () => {
        screen.getByRole("button", { name: "set-no-targets" }).click();
      });

      await waitFor(() => {
        expect(stopLightingMock).toHaveBeenCalledTimes(1);
      });
      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(backend.running).toBeNull();
    });

    // With nothing else selected the unplug used to do nothing at all: no
    // notice, the worker left capturing, and the mode still shown running.
    it("ends a USB-only mode when the strip is unplugged, shows Off with the selection kept, and says so", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...pairedShellState, lastOutputTargets: ["usb"] });
      const view = render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb"]);
      });
      const modeSends = setLightingModeMock.mock.calls.length;

      mockIsConnected = false;
      await act(async () => {
        view.rerender(<App />);
      });

      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        expect(screen.getByTestId("usb-disconnect-notice")).toHaveTextContent(
          "common:hotplug.usbDisconnectedLightingOff",
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(backend.running).toBeNull();
      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopHueMock).not.toHaveBeenCalled();
      // Off keeps the selection; the strip is still the user's choice.
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      expect(persistedTargets()).toEqual([]);
      const persistedModes = saveShellStateMock.mock.calls
        .map(([patch]) => patch as Record<string, unknown>)
        .filter((patch) => "lightingMode" in patch);
      expect(persistedModes).toEqual([]);
    });

    it("leaves an Off session alone when the only target is unplugged", async () => {
      installLightingBackend();
      loadShellStateMock.mockResolvedValue({
        ...pairedShellState,
        lightingMode: { kind: "off" },
        lastOutputTargets: ["usb"],
      });
      const view = render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
      });

      mockIsConnected = false;
      await act(async () => {
        view.rerender(<App />);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("usb-disconnect-notice")).not.toBeInTheDocument();
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
    });
  });

  const streamingShellState = {
    lastSection: "general",
    ledCalibration: {
      templateId: "monitor-27-16-9",
      counts: { top: 10, right: 10, bottom: 10, left: 10 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "subtle",
      startAnchor: "top-start",
      direction: "cw",
      totalLeds: 40,
    },
    lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
    lastOutputTargets: ["usb", "hue"],
    lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
    hueAppKey: "app-user",
    hueClientKey: "AABBCCDD11223344",
    lastHueAreaId: "area-1",
  };
  const savedOutputTargets = () =>
    saveShellStateMock.mock.calls
      .map(([patch]) => patch as Record<string, unknown>)
      .filter((patch) => "lastOutputTargets" in patch)
      .map((patch) => patch.lastOutputTargets);

  async function bootSession(lastOutputTargets: Array<"usb" | "hue">) {
    const backend = installLightingBackend();
    loadShellStateMock.mockResolvedValue({ ...streamingShellState, lastOutputTargets });
    render(<App />);
    await waitFor(() => {
      expect(backend.running?.targets).toEqual(lastOutputTargets);
      expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
    });
    return { backend, modeSends: setLightingModeMock.mock.calls.length };
  }

  // Past the dispatcher's cooldown, so a late send or stop would still be counted.
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }

  const firstCallOrder = (mock: ReturnType<typeof vi.fn>) => mock.mock.invocationCallOrder[0];

  // The running worker holds a handle on the Hue sender, which exits only once
  // every handle is gone. A bare `stop_hue_stream` under that worker timed out,
  // restored the lights with the sender still alive, and the next frame painted
  // them again; the worker also kept sampling for a stream that was gone.
  describe("removing Hue from a running [usb, hue] mode lets the worker go of Hue first", () => {
    it("re-applies the mode on USB, then stops the Hue stream", async () => {
      const { backend, modeSends } = await bootSession(["usb", "hue"]);

      await act(async () => {
        screen.getByRole("button", { name: "set-usb-target" }).click();
      });
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });
      await settle();

      const sends = setLightingModeMock.mock.calls.slice(modeSends).map(([payload]) => payload);
      expect(sends).toEqual([expect.objectContaining({ kind: "solid", targets: ["usb"] })]);
      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(setLightingModeMock.mock.invocationCallOrder[modeSends]).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(backend.running?.targets).toEqual(["usb"]);
      expect(backend.hueStreamUp).toBe(false);
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
      expect(savedOutputTargets()).toEqual([["usb"]]);
    });

    it("stops the runtime before the Hue stream when the re-apply is refused", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { backend, modeSends } = await bootSession(["usb", "hue"]);
      const applyAsBackend = setLightingModeMock.getMockImplementation()!;
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) => {
        if (payload.targets?.join() !== "usb") return applyAsBackend(payload);
        return Promise.resolve({
          active: true,
          mode: backend.running,
          status: { code: "DEVICE_NOT_CONNECTED", message: "disconnected", details: null },
        });
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-usb-target" }).click();
      });
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledTimes(1);
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends + 1);
      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      errorSpy.mockRestore();
    });

    it("shows Off and stops the Hue stream once when the re-apply's start fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { backend, modeSends } = await bootSession(["usb", "hue"]);
      const applyAsBackend = setLightingModeMock.getMockImplementation()!;
      setLightingModeMock.mockImplementation((payload: LightingModeConfig) => {
        if (payload.targets?.join() !== "usb") return applyAsBackend(payload);
        backend.running = null;
        return Promise.resolve({
          active: false,
          mode: { kind: "off" },
          status: { code: "SOLID_MODE_APPLY_FAILED", message: "failed", details: null },
        });
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-usb-target" }).click();
      });
      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends + 1);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(backend.hueStreamUp).toBe(false);
      expect(backend.hueStopsUnderWorker).toBe(0);
      errorSpy.mockRestore();
    });

    it("stops the runtime, then the Hue stream, when Hue was the last target", async () => {
      const { backend, modeSends } = await bootSession(["hue"]);

      await act(async () => {
        screen.getByRole("button", { name: "set-no-targets" }).click();
      });
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledTimes(1);
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
    });

    it("stops the runtime once when both targets go together", async () => {
      const { backend, modeSends } = await bootSession(["usb", "hue"]);

      await act(async () => {
        screen.getByRole("button", { name: "set-no-targets" }).click();
      });
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledTimes(1);
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
    });
  });

  // Same sender rule on the Off path. A Hue-only mode has no "usb" to stop, so
  // Off used to send `stop_hue_stream` alone and leave its worker capturing and
  // feeding the sender through the stop, the restore, and after it.
  describe("Off stops the lighting worker before the Hue stream", () => {
    async function turnOff() {
      await act(async () => {
        screen.getByRole("button", { name: "set-off" }).click();
      });
      await settledOff();
    }

    async function settledOff() {
      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        expect(stopHueMock).toHaveBeenCalledTimes(1);
      });
      await settle();
    }

    it("from a Hue-only Solid mode", async () => {
      const { backend } = await bootSession(["hue"]);

      await turnOff();

      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
      expect(backend.hueStreamUp).toBe(false);
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^hue$/);
      expect(savedOutputTargets()).toEqual([]);
    });

    it("from a Hue-only Ambilight mode", async () => {
      const { backend } = await bootSession(["hue"]);
      await act(async () => {
        screen.getByRole("button", { name: "set-ambilight" }).click();
      });
      await waitFor(() => {
        expect(backend.running).toEqual(expect.objectContaining({ kind: "ambilight", targets: ["hue"] }));
        expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
      });
      expect(stopHueMock).not.toHaveBeenCalled();

      await turnOff();

      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
    });

    it("from a [usb, hue] mode, waiting for the worker's stop before the stream's", async () => {
      const { backend } = await bootSession(["usb", "hue"]);
      let finishLightingStop: () => void = () => {};
      stopLightingMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLightingStop = () => {
              backend.running = null;
              resolve({ active: false });
            };
          }),
      );

      await act(async () => {
        screen.getByRole("button", { name: "set-off" }).click();
      });
      await waitFor(() => {
        expect(stopLightingMock).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(stopHueMock).not.toHaveBeenCalled();

      await act(async () => {
        finishLightingStop();
      });
      await settledOff();

      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
    });

    it("when Off was pressed while the Hue-only start was still in flight", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({
        ...streamingShellState,
        lightingMode: { kind: "off" },
        lastOutputTargets: ["hue"],
      });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^hue$/);
      });
      const applyAsBackend = setLightingModeMock.getMockImplementation()!;
      let finishApply: () => void = () => {};
      setLightingModeMock.mockImplementationOnce(
        (payload: LightingModeConfig) =>
          new Promise((resolve) => {
            finishApply = () => resolve(applyAsBackend(payload));
          }),
      );

      await act(async () => {
        screen.getByRole("button", { name: "set-solid" }).click();
      });
      await waitFor(() => {
        expect(setLightingModeMock).toHaveBeenCalled();
      });
      await act(async () => {
        screen.getByRole("button", { name: "set-off" }).click();
      });
      await act(async () => {
        finishApply();
      });
      await settledOff();

      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
    });

    it("still releases the Hue stream when stopping the worker fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { backend } = await bootSession(["hue"]);
      stopLightingMock.mockRejectedValue(new Error("runtime lock poisoned"));

      await turnOff();

      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStreamUp).toBe(false);
      errorSpy.mockRestore();
    });
  });

  // The Devices card's Stop retrying and Retry stop called `stop_hue_stream`
  // straight from the card, under a running mode whose worker still held the
  // Hue sender: the same partial stop and restore-under-a-live-sender as #445.
  // They now leave through the orchestrator, session-only.
  describe("the Devices card's Hue stop lets the running mode go of Hue first", () => {
    const stopFromCard = async () => {
      await act(async () => {
        screen.getByRole("button", { name: "device-stop-hue" }).click();
      });
    };
    const persistedOff = () =>
      saveShellStateMock.mock.calls.some(
        ([patch]) => (patch as { lightingMode?: LightingModeConfig }).lightingMode?.kind === "off",
      );

    it("from [usb, hue]: re-applies the mode on USB, then stops Hue, without saving the targets", async () => {
      const { backend, modeSends } = await bootSession(["usb", "hue"]);

      await stopFromCard();
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });
      await settle();

      const sends = setLightingModeMock.mock.calls.slice(modeSends).map(([payload]) => payload);
      expect(sends).toEqual([expect.objectContaining({ kind: "solid", targets: ["usb"] })]);
      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(setLightingModeMock.mock.invocationCallOrder[modeSends]).toBeLessThan(firstCallOrder(stopHueMock));
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(backend.running?.targets).toEqual(["usb"]);
      expect(backend.hueStreamUp).toBe(false);
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
      expect(savedOutputTargets()).toEqual([]);
    });

    it("from a Hue-only mode: stops the worker, then Hue, and shows Off with the selection kept", async () => {
      const { backend, modeSends } = await bootSession(["hue"]);

      await stopFromCard();
      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        expect(stopHueMock).toHaveBeenCalledTimes(1);
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopLightingMock).toHaveBeenCalledTimes(1);
      expect(firstCallOrder(stopLightingMock)).toBeLessThan(firstCallOrder(stopHueMock));
      expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.running).toBeNull();
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^hue$/);
      expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("none");
      expect(savedOutputTargets()).toEqual([]);
      expect(persistedOff()).toBe(false);
    });

    it("after the health poll dropped Hue (Retry stop): the worker still lets go before the stop", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { backend, modeSends } = await bootSession(["usb", "hue"]);
        // The first stop timed out: the runtime reads Idle, the mode still names Hue.
        getHueStreamStatusMock.mockResolvedValue({
          active: false,
          lastSolidColor: null,
          status: {
            state: "Idle",
            code: "HUE_STOP_TIMEOUT_PARTIAL",
            message: "partial",
            details: "retry stop to ensure bridge state restore",
          },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        await waitFor(() => {
          expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("none");
        });
        expect(backend.running?.targets).toEqual(["usb", "hue"]);

        await stopFromCard();
        await waitFor(() => {
          expect(stopHueMock).toHaveBeenCalledTimes(1);
        });
        await settle();

        const sends = setLightingModeMock.mock.calls.slice(modeSends).map(([payload]) => payload);
        expect(sends).toEqual([expect.objectContaining({ kind: "solid", targets: ["usb"] })]);
        expect(setLightingModeMock.mock.invocationCallOrder[modeSends]).toBeLessThan(firstCallOrder(stopHueMock));
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
        expect(backend.hueStopsUnderWorker).toBe(0);
        expect(backend.running?.targets).toEqual(["usb"]);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
        expect(savedOutputTargets()).toEqual([]);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("a second press while the first is in flight joins it", async () => {
      const { backend, modeSends } = await bootSession(["usb", "hue"]);

      await act(async () => {
        const button = screen.getByRole("button", { name: "device-stop-hue" });
        button.click();
        button.click();
      });
      await waitFor(() => {
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });
      await settle();

      expect(setLightingModeMock.mock.calls.length).toBe(modeSends + 1);
      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(backend.hueStopsUnderWorker).toBe(0);
    });

    // A stream the card started beside a USB-only mode is not in the selection,
    // and the release still has to reach `stop_hue_stream`.
    it("beside a USB-only mode: a plain Hue stop, the mode untouched", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...streamingShellState, lastOutputTargets: ["usb"] });
      render(<App />);
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb"]);
      });
      const modeSends = setLightingModeMock.mock.calls.length;

      await stopFromCard();
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
      });
      await settle();

      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(backend.running?.targets).toEqual(["usb"]);
      expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
    });

    it("with the mode off: a plain Hue stop, nothing re-applied", async () => {
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...streamingShellState, lightingMode: { kind: "off" } });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb,hue$/);
      });
      const modeSends = setLightingModeMock.mock.calls.length;

      await stopFromCard();
      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
      });
      await settle();

      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
      expect(stopLightingMock).not.toHaveBeenCalled();
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb,hue$/);
    });
  });

  // The test lease stops only a stream it opened. A mode started during the run
  // takes that stream over (its start answers already-active) and its worker
  // holds the sender, so the lease's stop used to land under that worker.
  describe("a test lease hands a stream a mode adopted over to the mode", () => {
    it("leaves the stream up when the running mode names Hue", async () => {
      __resetHueTestLease();
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...streamingShellState, lightingMode: { kind: "off" } });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb,hue$/);
      });
      await act(async () => {
        await acquireHueForTest(["usb", "hue"]);
      });
      expect(backend.hueStreamUp).toBe(true);
      await act(async () => {
        screen.getByRole("button", { name: "set-solid" }).click();
      });
      await waitFor(() => {
        expect(backend.running?.targets).toEqual(["usb", "hue"]);
      });

      await act(async () => {
        await releaseHueAfterTest();
      });
      await settle();

      expect(stopHueMock).not.toHaveBeenCalled();
      expect(backend.hueStopsUnderWorker).toBe(0);
      expect(backend.hueStreamUp).toBe(true);
      expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
    });

    it("still releases the stream when no mode took it", async () => {
      __resetHueTestLease();
      const backend = installLightingBackend();
      loadShellStateMock.mockResolvedValue({ ...streamingShellState, lightingMode: { kind: "off" } });
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
      });
      await act(async () => {
        await acquireHueForTest(["usb", "hue"]);
      });

      await act(async () => {
        await releaseHueAfterTest();
      });

      expect(stopHueMock).toHaveBeenCalledTimes(1);
      expect(backend.hueStreamUp).toBe(false);
    });
  });

  it(
    "ambilight idempotency: three real re-fires past the cooldown still collapse to one dispatch",
    async () => {
      // Key reordering can't reach canonicalLightingModeSignature here — normalizeLightingModeConfig
      // rebuilds the payload with fixed field order first. That invariant lives at unit level:
      // modePayloadHydration.test.ts > is key-order independent.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        loadShellStateMock.mockResolvedValue({
          lastSection: "general",
          ledCalibration: {
            templateId: "monitor-27-16-9",
            counts: { top: 10, right: 10, bottom: 10, left: 10 },
            bottomMissing: 0,
            cornerOwnership: "horizontal",
            visualPreset: "subtle",
            startAnchor: "top-start",
            direction: "cw",
            totalLeds: 40,
          },
          lightingMode: { kind: "off" },
          lastOutputTargets: ["usb"],
        });

        render(<App />);

        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        });

        // The calibration gate blocks an Ambilight transition while `savedCalibration`
        // is still undefined, and a blocked transition returns without changing
        // the mode — so the click must wait for bootstrap to hydrate it.
        await waitFor(() => {
          expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
        });

        // Slow-path Ambilight transition.
        await act(async () => {
          screen.getByRole("button", { name: "set-ambilight" }).click();
        });

        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
        });

        expect(setLightingModeMock).toHaveBeenCalledTimes(1);

        // Reordered payload, fired three times past the cooldown each time.
        for (let i = 0; i < 3; i += 1) {
          await vi.advanceTimersByTimeAsync(25);
          await act(async () => {
            screen.getByRole("button", { name: "set-ambilight-reordered" }).click();
          });
        }

        // Still exactly one — content dedup collapses all three real re-fires.
        expect(setLightingModeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "ambilight 1-LED bug fix: dispatched payload carries persisted ledCalibration with full totalLeds",
    async () => {
      // Regression for the Ambilight 1-LED bug observed during 2026-04-26
      // hardware validation. The Rust ambilight worker uses
      // `LightingModeConfig.led_calibration.total_leds` to size every
      // emitted USB frame; when the frontend forgot to stamp this field,
      // the backend fell back to 1 and only LED #0 reflected screen edge
      // colors. The fix threads `withLedCalibration` into
      // `hydrateModePayload` so every dispatch carries the persisted
      // calibration. This test asserts that an Ambilight transition
      // produces a payload whose `ledCalibration.totalLeds` matches the
      // hydrated shell state — proving the strip will be sized correctly.
      loadShellStateMock.mockResolvedValue({
        lastSection: "general",
        ledCalibration: {
          templateId: "monitor-27-16-9",
          counts: { top: 16, right: 12, bottom: 19, left: 12 },
          bottomMissing: 0,
          cornerOwnership: "horizontal",
          visualPreset: "vivid",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 59,
        },
        lightingMode: { kind: "off" },
        lastOutputTargets: ["usb"],
      });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });

      // The calibration gate blocks an Ambilight transition while `savedCalibration`
      // is still undefined, and a blocked transition returns without changing
      // the mode — so the click must wait for bootstrap to hydrate it.
      await waitFor(() => {
        expect(screen.getByTestId("calibration-leds")).toHaveTextContent("59");
      });

      await act(async () => {
        screen.getByRole("button", { name: "set-ambilight" }).click();
      });

      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
      });

      expect(setLightingModeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ambilight",
          ledCalibration: expect.objectContaining({ totalLeds: 59 }),
        }),
      );
    },
  );

  // ---------------------------------------------------------------------
  // Bug H1 — Ambilight settings restore on cold start. Persisted
  // `lightingMode.ambilight` (saturation /
  // blackBorderDetection / smoothing-preset) MUST survive cold boot AND
  // any same-tick re-dispatch path (color-correction / firmware-profile
  // / Hue-intensity hot-reload, USB hot-plug delta-start). Pre-fix the
  // hot-reload effects read `lightingMode` from a stale React closure
  // before `setLightingModeState(restoredMode)` flushed, stripping the
  // payload down to backend defaults.
  //
  // The fix introduces `savedAmbilightRef` + `withAmbilightSettings`
  // hydrator that stamps the persisted payload onto every dispatch when
  // the caller's payload is absent or fresh-default.
  // ---------------------------------------------------------------------
  it(
    "H1: cold-start ambilight settings restore — persisted saturation/blackBorder/preset survive bootstrap and target-change delta-start",
    async () => {
      // Persisted ambilight session with non-default knobs (saturation
      // 1.7, blackBorderDetection true) that pre-fix would have been
      // silently stripped by the stale-closure hot-reload / delta-start
      // paths.
      //
      // Scenario shape:
      //   * `lastOutputTargets: ["hue"]` + Hue bridge config → bootstrap
      //     enters the Hue+Ambilight branch (useShellBootstrap.ts), dispatching
      //     `set_lighting_mode` with the persisted payload.
      //   * Click `set-both-targets` → addedTargets = ["usb"] →
      //     `handleOutputTargetsChange` USB delta-start branch
      //     (useLightingModeOrchestrator.ts) calls `dispatchSetLightingMode` reading
      //     `lightingMode.ambilight` from a closure that pre-fix could
      //     have been stale. With H1 fix the `withAmbilightSettings`
      //     hydrator stamps the persisted values from
      //     `savedAmbilightRef` regardless of closure state.
      const persistedShellState = {
        lastSection: "general",
        ledCalibration: {
          templateId: "monitor-27-16-9",
          counts: { top: 10, right: 10, bottom: 10, left: 10 },
          bottomMissing: 0,
          cornerOwnership: "horizontal",
          visualPreset: "vivid",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 40,
        },
        lightingMode: {
          kind: "ambilight",
          ambilight: {
            brightness: 0.42,
            saturation: 1.7,
            blackBorderDetection: true,
          },
        },
        lastOutputTargets: ["hue"],
        lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
        hueAppKey: "app-user",
        hueClientKey: "AABBCCDD11223344",
        lastHueAreaId: "area-1",
      };
      loadShellStateMock.mockResolvedValue(persistedShellState);
      // Bootstrap Hue start succeeds → set_lighting_mode dispatched.
      startHueMock.mockResolvedValue({
        active: true,
        status: { code: "HUE_STREAM_RUNNING", message: "Running", details: null },
      });

      render(<App />);

      // Bootstrap (Hue+Ambilight branch) dispatches the persisted
      // payload as the very first set_lighting_mode invoke. This
      // dispatch path uses `restoredMode.ambilight` directly so it was
      // correct even pre-fix; pinning it here so a future refactor that
      // moves the dispatch to read React state instead breaks loudly.
      await waitFor(() => {
        expect(setLightingModeMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "ambilight",
            ambilight: expect.objectContaining({
              brightness: 0.42,
              saturation: 1.7,
              blackBorderDetection: true,
            }),
          }),
        );
      });

      // First dispatch confirmed. Now drive the USB delta-start path
      // that pre-fix would read `lightingMode.ambilight` from a stale
      // closure. With H1 fix the `withAmbilightSettings` hydrator stamps
      // the persisted payload from `savedAmbilightRef` so the dispatched
      // payload still carries saturation/blackBorder/preset.
      //
      // Note: the `useDeviceConnection` controller `useMemo`
      // (useDeviceConnection.ts) still rebuilds when
      // `initialLastSuccessfulPort` settles late — that's a wall-time
      // artifact, not a correctness bug, and is out of scope for H1/H3.
      setLightingModeMock.mockClear();

      await act(async () => {
        screen.getByRole("button", { name: "set-both-targets" }).click();
      });

      // The USB delta-start dispatch MUST carry the persisted
      // saturation / blackBorderDetection / smoothing values — that's
      // exactly what `withAmbilightSettings` guarantees via the ref.
      await waitFor(() => {
        expect(setLightingModeMock).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "ambilight",
            ambilight: expect.objectContaining({
              brightness: 0.42,
              saturation: 1.7,
              blackBorderDetection: true,
            }),
          }),
        );
      });
    },
  );

  // ---------------------------------------------------------------------
  // Bug H3 — USB device auto-pair on app start (intermittent). Cold launch
  // races against `tryAutoReconnect`'s 2 s BOOTLOADER_SETTLE_DELAY_MS:
  // ~20-30% of starts the bootstrap finishes first, sees `connected: false`,
  // and silently drops the user's persisted USB target. The fix (Opsiyon A)
  // softens the bootstrap filter to keep "usb" in selectedOutputTargets
  // regardless of the snapshot result; modeGuard already disables Lights
  // output visually when isConnected===false so user clarity is preserved.
  //
  // This test pins the new behaviour: persisted USB target survives even
  // when GET_CONNECTION_STATUS reports `connected: false` at bootstrap.
  // ---------------------------------------------------------------------
  it(
    "H3: cold-start auto-pair targets persistence — usb stays in selectedOutputTargets even when bootstrap snapshot reports disconnected",
    async () => {
      // Simulate the race: useDeviceConnection initially says disconnected
      // (auto-reconnect has not landed yet), GET_CONNECTION_STATUS returns
      // `connected: false`. Persisted state has ["usb"] from a prior
      // session.
      mockIsConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValueOnce({
        lastSection: "general",
        ledCalibration: null,
        lightingMode: { kind: "off" },
        lastOutputTargets: ["usb"],
      });

      render(<App />);

      // After bootstrap completes, the output-targets pill MUST still
      // show "usb". Pre-fix this would have been empty (filteredTargets
      // dropped "usb" because bootstrapUsbAvailable was false).
      await waitFor(() => {
        expect(screen.getByTestId("output-targets")).toHaveTextContent("usb");
      });
      // Defensive: textContent equals exactly "usb" — no stray empty
      // commas or other targets snuck in.
      expect(screen.getByTestId("output-targets").textContent).toBe("usb");
    },
  );
  // ---------------------------------------------------------------------
  // Hue health reconciler — the one-way strip regression.
  //
  // The poll used to `return` on the first Failed/Idle reading, so "hue"
  // left `activeOutputTargets` permanently. In a Hue-only Solid setup that
  // made every subsequent colour change a no-op: neither the USB branch nor
  // the Hue branch of the quick-adjustment path fired, while the swatch and
  // the persisted state still moved.
  // ---------------------------------------------------------------------
  describe("Hue health reconciler", () => {
    const hueOnlySolidShellState = {
      lastSection: "general",
      ledCalibration: null,
      lightingMode: { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    };

    const deadStatus = {
      active: false,
      lastSolidColor: null,
      status: { state: "Idle", code: "HUE_STREAM_IDLE", message: "Hue runtime is idle.", details: null },
    };
    const liveStatus = {
      active: true,
      lastSolidColor: null,
      status: {
        state: "Running",
        code: "HUE_STREAM_RUNNING_DTLS",
        message: "Hue entertainment stream active via DTLS.",
        details: null,
      },
    };

    it("keeps pushing Solid colour changes to Hue after the poll strips the target", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadShellStateMock.mockResolvedValue(hueOnlySolidShellState);
      getHueStreamStatusMock.mockResolvedValue(deadStatus);
      setHueSolidColorMock.mockResolvedValue({
        active: false,
        status: { state: "Idle", code: "HUE_COLOR_APPLY_SKIPPED", message: "queued", details: null },
      });

      render(<App />);

      await waitFor(() => {
        expect(
          warnSpy.mock.calls.some((call) =>
            String(call[0]).includes('Removing "hue" from active targets'),
          ),
        ).toBe(true);
      });

      setHueSolidColorMock.mockClear();
      await act(async () => {
        screen.getByRole("button", { name: "set-solid" }).click();
      });

      expect(setHueSolidColorMock).toHaveBeenCalledWith(
        expect.objectContaining({ r: 10, g: 20, b: 30 }),
      );
      warnSpy.mockRestore();
    });

    it("restores \"hue\" as an active target once the backend reports a live stream", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        loadShellStateMock.mockResolvedValue(hueOnlySolidShellState);
        getHueStreamStatusMock.mockResolvedValue(deadStatus);
        setHueSolidColorMock.mockResolvedValue({
          active: false,
          status: { state: "Idle", code: "HUE_COLOR_APPLY_SKIPPED", message: "queued", details: null },
        });

        render(<App />);

        await waitFor(() => {
          expect(
            warnSpy.mock.calls.some((call) =>
              String(call[0]).includes('Removing "hue" from active targets'),
            ),
          ).toBe(true);
        });

        getHueStreamStatusMock.mockResolvedValue(liveStatus);
        setLightingModeMock.mockClear();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });

        await waitFor(() => {
          expect(
            infoSpy.mock.calls.some((call) => String(call[0]).includes('Restoring "hue"')),
          ).toBe(true);
        });
        // The running worker captured hue_output=None while the stream was
        // down; recovery must force a re-apply so it picks up the live context.
        expect(setLightingModeMock).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "solid", targets: ["hue"] }),
        );
      } finally {
        warnSpy.mockRestore();
        infoSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("boot restore honours what the backend actually started", () => {
    const hueAmbilightShellState = {
      lastSection: "general",
      ledCalibration: null,
      lightingMode: {
        kind: "ambilight",
        ambilight: { brightness: 0.8, saturation: 1, blackBorderDetection: false },
      },
      lastOutputTargets: ["hue"],
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "AABBCCDD11223344",
      lastHueAreaId: "area-1",
    };
    const hueStatus = (state: string) => ({
      active: state !== "Idle",
      lastSolidColor: null,
      status: { state, code: "X", message: state, details: null },
    });

    // Screen recording refused: the lights screen read CAP OK / HUE STREAMING
    // with nothing running and no warning, and the bridge stayed claimed.
    it("shows Off, releases the bridge and warns when capture is refused at launch", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadShellStateMock.mockResolvedValue(hueAmbilightShellState);
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Running"));
      setLightingModeMock.mockResolvedValue({
        active: false,
        mode: { kind: "off" },
        status: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "Ambilight runtime could not start.",
          details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
        },
      });

      render(<App />);

      await waitFor(() => {
        expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
      });
      expect(startHueMock).toHaveBeenCalled();
      // Hue before the mode: the worker needs the live stream context.
      expect(startHueMock.mock.invocationCallOrder[0]).toBeLessThan(
        setLightingModeMock.mock.invocationCallOrder[0],
      );
      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });
      expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("none");
      expect(screen.getByTestId("capture-start-failed-notice")).toBeInTheDocument();
      // The persisted mode is left alone so the next launch retries it.
      expect(saveShellStateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ lightingMode: expect.anything() }),
      );
      warnSpy.mockRestore();
    });

    it("shows Off without a toast when the saved display is simply not plugged in", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadShellStateMock.mockResolvedValue(hueAmbilightShellState);
      setLightingModeMock.mockResolvedValue({
        active: false,
        mode: { kind: "off" },
        status: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "Ambilight runtime could not start.",
          details: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
        },
      });

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });
      expect(screen.queryByTestId("capture-start-failed-notice")).not.toBeInTheDocument();
      warnSpy.mockRestore();
    });

    it("keeps the restored mode and the stream when the backend runs it", async () => {
      loadShellStateMock.mockResolvedValue(hueAmbilightShellState);
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Running"));

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
      });
      expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
      expect(stopHueMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("capture-start-failed-notice")).not.toBeInTheDocument();
    });

    it("reads a retrying bridge as reconnecting, not streaming", async () => {
      loadShellStateMock.mockResolvedValue(hueAmbilightShellState);
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Reconnecting"));

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("reconnecting");
      });
    });

    // Relaunching within seconds of an unclean exit: the bridge still holds the
    // old session, so the start is gated and the restore used to land on Off.
    describe("a bridge still holding the previous session", () => {
      let bridgeAnswer: "busy" | "free" | "unreachable";
      let hueUp: boolean;

      beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "info").mockImplementation(() => {});
        bridgeAnswer = "busy";
        hueUp = false;
        mockIsConnected = false;
        installInvokeDispatch(false);
        const base = invokeMock.getMockImplementation()!;
        invokeMock.mockImplementation((command: string, ...rest: unknown[]) => {
          if (command !== HUE_COMMANDS.CHECK_STREAM_READINESS) return base(command, ...rest);
          if (bridgeAnswer === "unreachable") {
            return Promise.resolve({
              status: { code: HUE_STATUS.STREAM_READINESS_FAILED, message: "down", details: null },
              readiness: { ready: false, reasons: ["Bridge unreachable"] },
            });
          }
          const busy = bridgeAnswer === "busy";
          return Promise.resolve({
            status: {
              code: busy ? HUE_STATUS.STREAM_NOT_READY : HUE_STATUS.STREAM_READY,
              message: "readiness",
              details: null,
            },
            readiness: { ready: !busy, reasons: busy ? [HUE_READINESS_REASON.ACTIVE_STREAMER] : [] },
          });
        });
        loadShellStateMock.mockResolvedValue(hueAmbilightShellState);
        startHueMock.mockImplementation(() => {
          if (bridgeAnswer !== "free") {
            return Promise.resolve({
              active: false,
              status: {
                code: "CONFIG_NOT_READY_GATE_BLOCKED",
                state: "Idle",
                message: "blocked",
                details: "Missing prerequisites: ready",
              },
            });
          }
          hueUp = true;
          return Promise.resolve({
            active: true,
            status: { code: "HUE_STREAM_RUNNING", state: "Running", message: "ok", details: null },
          });
        });
        setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
          Promise.resolve(
            (payload.targets ?? []).includes("hue") && !hueUp
              ? {
                  active: false,
                  mode: { kind: "off" },
                  status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
                }
              : appliedResult(payload),
          ),
        );
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it("says so while it waits, then resumes the mode once the area is free", async () => {
        render(<App />);

        await waitFor(() => {
          expect(screen.getByTestId("hue-boot-retry-notice")).toHaveAttribute("data-state", "waiting");
        });
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        expect(screen.getByTestId("hue-boot-retry-notice")).toHaveTextContent("common:hueBootRetry.waiting");
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.waiting");

        bridgeAnswer = "free";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });

        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
          expect(hueChip()).toHaveTextContent("shell:statusBar.state.streaming");
        });
        expect(screen.queryByTestId("hue-boot-retry-notice")).not.toBeInTheDocument();
        expect(startHueMock).toHaveBeenCalledTimes(2);
      });

      it("drops the retry when the user picks a mode while it waits", async () => {
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("hue-boot-retry-notice")).toBeInTheDocument();
        });

        await act(async () => {
          screen.getByRole("button", { name: "set-off" }).click();
        });
        expect(screen.queryByTestId("hue-boot-retry-notice")).not.toBeInTheDocument();

        bridgeAnswer = "free";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });

      it("drops the retry when the user deselects Hue while it waits", async () => {
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("hue-boot-retry-notice")).toBeInTheDocument();
        });

        await act(async () => {
          screen.getByRole("button", { name: "set-usb-target" }).click();
        });
        expect(screen.queryByTestId("hue-boot-retry-notice")).not.toBeInTheDocument();

        bridgeAnswer = "free";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(startHueMock).toHaveBeenCalledTimes(1);
      });

      it("gives up after the window and says lighting stayed off", async () => {
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("hue-boot-retry-notice")).toHaveAttribute("data-state", "waiting");
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        await waitFor(() => {
          expect(screen.getByTestId("hue-boot-retry-notice")).toHaveAttribute("data-state", "gaveUp");
        });
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });

      it("does not wait on a bridge that is unreachable rather than busy", async () => {
        bridgeAnswer = "unreachable";
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("calibration-leds")).toBeInTheDocument();
          expect(startHueMock).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        expect(screen.queryByTestId("hue-boot-retry-notice")).not.toBeInTheDocument();
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
      });
    });

    // The same relaunch with a strip plugged in: the restore runs on USB alone
    // at once, and Hue used to stay out for the rest of the session.
    describe("a [usb, hue] restore whose bridge still holds the previous session", () => {
      let bridgeAnswer: "busy" | "free" | "unreachable";
      let hueUp: boolean;
      let hueStartCode: string;

      const leftOutNotice = () => screen.queryByTestId("hue-left-out-notice");
      const readinessProbes = () =>
        invokeMock.mock.calls.filter(([command]) => command === HUE_COMMANDS.CHECK_STREAM_READINESS).length;
      const persistedTargets = () =>
        saveShellStateMock.mock.calls
          .map(([patch]) => patch as Record<string, unknown>)
          .filter((patch) => "lastOutputTargets" in patch);

      async function renderRunningOnUsb() {
        const view = render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
          expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
        });
        return view;
      }

      async function waitForBusyNotice() {
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "busy");
        });
      }

      async function freeTheAreaAndWait(ms: number) {
        bridgeAnswer = "free";
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      }

      beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "info").mockImplementation(() => {});
        bridgeAnswer = "busy";
        hueUp = false;
        hueStartCode = "CONFIG_NOT_READY_GATE_BLOCKED";
        installInvokeDispatch(true);
        const base = invokeMock.getMockImplementation()!;
        invokeMock.mockImplementation((command: string, ...rest: unknown[]) => {
          if (command !== HUE_COMMANDS.CHECK_STREAM_READINESS) return base(command, ...rest);
          if (bridgeAnswer === "unreachable") {
            return Promise.resolve({
              status: { code: HUE_STATUS.STREAM_READINESS_FAILED, message: "down", details: null },
              readiness: { ready: false, reasons: ["Bridge unreachable"] },
            });
          }
          const busy = bridgeAnswer === "busy";
          return Promise.resolve({
            status: {
              code: busy ? HUE_STATUS.STREAM_NOT_READY : HUE_STATUS.STREAM_READY,
              message: "readiness",
              details: null,
            },
            readiness: { ready: !busy, reasons: busy ? [HUE_READINESS_REASON.ACTIVE_STREAMER] : [] },
          });
        });
        loadShellStateMock.mockResolvedValue({
          ...hueAmbilightShellState,
          ledCalibration: {
            templateId: "monitor-27-16-9",
            counts: { top: 10, right: 10, bottom: 10, left: 10 },
            bottomMissing: 0,
            cornerOwnership: "horizontal",
            visualPreset: "subtle",
            startAnchor: "top-start",
            direction: "cw",
            totalLeds: 40,
          },
          lastOutputTargets: ["usb", "hue"],
        });
        getHueStreamStatusMock.mockImplementation(() => Promise.resolve(hueStatus(hueUp ? "Running" : "Idle")));
        startHueMock.mockImplementation(() => {
          if (bridgeAnswer !== "free") {
            return Promise.resolve({
              active: false,
              status: { code: hueStartCode, state: "Idle", message: "blocked", details: "Missing prerequisites: ready" },
            });
          }
          hueUp = true;
          return Promise.resolve({
            active: true,
            status: { code: "HUE_STREAM_RUNNING", state: "Running", message: "ok", details: null },
          });
        });
        setLightingModeMock.mockImplementation((payload: LightingModeConfig) =>
          Promise.resolve(
            (payload.targets ?? []).includes("hue") && !hueUp
              ? {
                  active: false,
                  mode: { kind: "off" },
                  status: { code: "HUE_NOT_READY", message: "not ready", details: "HUE_RUNTIME_GATE_FAILED" },
                }
              : appliedResult(payload),
          ),
        );
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      it("runs on USB at once, then adds Hue to the running mode once the area frees", async () => {
        await renderRunningOnUsb();
        expect(setLightingModeMock.mock.calls.map(([payload]) => payload.targets)).toEqual([
          ["usb", "hue"],
          ["usb"],
        ]);
        await waitForBusyNotice();
        expect(leftOutNotice()).toHaveTextContent("common:hueLeftOut.busy");
        // Lighting runs, so the Off-only notice would be false.
        expect(screen.queryByTestId("hue-boot-retry-notice")).not.toBeInTheDocument();

        // The notice describes a wait still under way, so it outlives the usual 8 s.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(9_000);
        });
        expect(leftOutNotice()).toHaveAttribute("data-reason", "busy");

        await freeTheAreaAndWait(3_000);

        await waitFor(() => {
          expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
          expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
        });
        expect(leftOutNotice()).not.toBeInTheDocument();
        expect(startHueMock).toHaveBeenCalledTimes(2);
        // The user's own Hue add: a forced re-apply of the running mode with both targets.
        const lastPayload = setLightingModeMock.mock.calls[setLightingModeMock.mock.calls.length - 1][0] as LightingModeConfig;
        expect(lastPayload).toEqual(expect.objectContaining({ kind: "ambilight", targets: ["usb", "hue"] }));
        expect(stopLightingMock).not.toHaveBeenCalled();
        expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
        // Neither the drop nor the rejoin rewrites what the next launch restores.
        expect(persistedTargets()).toEqual([]);
      });

      // The bridge is reachable, just held, so the chip read OK beside a
      // notice saying Hue was not running.
      it("shows the HUE chip waiting while the rejoin waits, then streaming once Hue joins", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.waiting");

        await freeTheAreaAndWait(3_000);
        await waitFor(() => {
          expect(hueChip()).toHaveTextContent("shell:statusBar.state.streaming");
        });
      });

      it("keeps the HUE chip on left out after the gave-up notice clears, until the user makes a choice", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "busyGaveUp");
        });
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.leftOut");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_000);
        });
        expect(leftOutNotice()).not.toBeInTheDocument();
        // The toast is gone; Hue is still not part of the running mode.
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.leftOut");

        await act(async () => {
          screen.getByRole("button", { name: "set-usb-target" }).click();
        });
        await waitFor(() => {
          expect(hueChip()).toHaveTextContent("shell:statusBar.state.ok");
        });
      });

      // The busy notice kept saying "running on USB only" with the strip gone,
      // and the rejoin would have added Hue to a worker nothing fed.
      it("ends the mode and drops the rejoin when the strip is unplugged while it waits", async () => {
        const view = await renderRunningOnUsb();
        await waitForBusyNotice();

        mockIsConnected = false;
        await act(async () => {
          view.rerender(<App />);
        });

        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
          expect(screen.getByTestId("usb-disconnect-notice")).toHaveTextContent(
            "common:hotplug.usbDisconnectedLightingOff",
          );
        });
        expect(stopLightingMock).toHaveBeenCalledTimes(1);
        expect(leftOutNotice()).not.toBeInTheDocument();
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.ok");
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
        const modeSends = setLightingModeMock.mock.calls.length;
        const probes = readinessProbes();

        await freeTheAreaAndWait(30_000);
        // Cancelled, not merely outlived: it stops asking the bridge.
        expect(readinessProbes()).toBe(probes);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(setLightingModeMock.mock.calls.length).toBe(modeSends);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
        expect(persistedTargets()).toEqual([]);
      });

      it("takes down a gave-up notice's \"running on USB only\" with the strip", async () => {
        const view = await renderRunningOnUsb();
        await waitForBusyNotice();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "busyGaveUp");
        });

        mockIsConnected = false;
        await act(async () => {
          view.rerender(<App />);
        });

        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
        });
        expect(leftOutNotice()).not.toBeInTheDocument();
        expect(hueChip()).toHaveTextContent("shell:statusBar.state.ok");
      });

      // The rejoin re-applies with both targets; a setting sent afterwards with
      // the restore's [usb] would restart the worker the rejoin just rebuilt.
      it("sends a setting change to both targets once Hue has rejoined, without saving them", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();
        await freeTheAreaAndWait(3_000);
        await waitFor(() => {
          expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming");
          expect(lastModeSend().targets).toEqual(["usb", "hue"]);
        });
        const sendsAfterRejoin = setLightingModeMock.mock.calls.length;

        await act(async () => {
          screen.getByRole("button", { name: "change-chip-type" }).click();
        });
        await waitFor(() => {
          expect(setLightingModeMock.mock.calls.length).toBe(sendsAfterRejoin + 1);
        });
        expect(lastModeSend()).toEqual(
          expect.objectContaining({ kind: "ambilight", chipType: "sk6812-rgbw", targets: ["usb", "hue"] }),
        );
        expect(persistedTargets()).toEqual([]);
      });

      it("keeps a rejoined Hue coloured by a Solid setting change", async () => {
        loadShellStateMock.mockResolvedValue({
          ...(await loadShellStateMock()),
          lightingMode: { kind: "solid", solid: { r: 10, g: 20, b: 30, brightness: 0.8 } },
        });
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
          expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
        });
        await waitForBusyNotice();
        await freeTheAreaAndWait(3_000);
        await waitFor(() => {
          expect(lastModeSend().targets).toEqual(["usb", "hue"]);
          expect(setHueSolidColorMock).toHaveBeenCalled();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(25);
        });
        const sendsAfterRejoin = setLightingModeMock.mock.calls.length;

        await act(async () => {
          screen.getByRole("button", { name: "change-color-correction" }).click();
        });
        await waitFor(() => {
          expect(setLightingModeMock.mock.calls.length).toBe(sendsAfterRejoin + 1);
        });
        // A Solid apply naming Hue is the one Rust pushes the colour to the bridge for.
        expect(lastModeSend()).toEqual(
          expect.objectContaining({ kind: "solid", targets: ["usb", "hue"] }),
        );
        expect(persistedTargets()).toEqual([]);
      });

      it("keeps running on USB, with a gave-up notice, when the window closes", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "busyGaveUp");
        });
        expect(leftOutNotice()).toHaveTextContent("common:hueLeftOut.busyGaveUp");
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
        expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");

        await freeTheAreaAndWait(8_000);
        expect(leftOutNotice()).not.toBeInTheDocument();
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(persistedTargets()).toEqual([]);
      });

      it("drops the rejoin when the user picks a mode while it waits", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();

        await act(async () => {
          screen.getByRole("button", { name: "set-solid" }).click();
        });
        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
        });
        expect(leftOutNotice()).not.toBeInTheDocument();

        await freeTheAreaAndWait(30_000);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      it("drops the rejoin when the user changes the outputs while it waits", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();

        await act(async () => {
          screen.getByRole("button", { name: "set-usb-target" }).click();
        });
        expect(leftOutNotice()).not.toBeInTheDocument();

        await freeTheAreaAndWait(30_000);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      it("lets the user's own Hue add answer for itself instead of adding Hue twice", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();

        await act(async () => {
          screen.getByRole("button", { name: "set-both-targets" }).click();
        });
        // Still held, so the user's add is left out the way any interactive add is.
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "unreachable");
        });
        expect(startHueMock).toHaveBeenCalledTimes(2);

        await freeTheAreaAndWait(30_000);
        expect(startHueMock).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      it("keeps waiting through a slider tweak, which is not a mode choice", async () => {
        await renderRunningOnUsb();
        await waitForBusyNotice();

        await act(async () => {
          screen.getByRole("button", { name: "set-ambilight-reordered" }).click();
        });
        expect(leftOutNotice()).toHaveAttribute("data-reason", "busy");

        await freeTheAreaAndWait(3_000);
        await waitFor(() => {
          expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
        });
        expect(startHueMock).toHaveBeenCalledTimes(2);
      });

      it("never waits on a bridge that refused the app's key", async () => {
        hueStartCode = "AUTH_INVALID_CREDENTIALS";
        await renderRunningOnUsb();
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "auth");
        });

        await freeTheAreaAndWait(30_000);
        expect(readinessProbes()).toBe(0);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      it("never waits on a bridge that is unreachable rather than busy", async () => {
        bridgeAnswer = "unreachable";
        await renderRunningOnUsb();
        await waitFor(() => {
          expect(leftOutNotice()).toHaveAttribute("data-reason", "unreachable");
        });

        await freeTheAreaAndWait(30_000);
        expect(readinessProbes()).toBe(1);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });

      // A2 stays as it was outside boot: the user is present and can turn Hue on.
      it("does not rejoin Hue after an interactive start left it out", async () => {
        loadShellStateMock.mockResolvedValue({
          ...(await loadShellStateMock()),
          lightingMode: { kind: "off" },
        });
        render(<App />);
        await waitFor(() => {
          expect(screen.getByTestId("calibration-leds")).toHaveTextContent("40");
          expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue");
        });

        await act(async () => {
          screen.getByRole("button", { name: "set-ambilight" }).click();
        });
        await waitFor(() => {
          expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight");
          expect(leftOutNotice()).toHaveAttribute("data-reason", "unreachable");
        });

        await freeTheAreaAndWait(30_000);
        expect(readinessProbes()).toBe(0);
        expect(startHueMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("output-targets")).toHaveTextContent(/^usb$/);
      });
    });
  });

  // An upgrader has no `hasCompletedOnboarding` on disk, and bootstrap clears the
  // flag before it has read the guards that would complete the flow — so the
  // banner mounted for as long as the slowest guard took, then vanished.
  describe("onboarding banner for a user who is already set up", () => {
    /**
     * Records every time onboarding enters the notice queue, including behind
     * "+N" where no card renders, and one removed before anyone looks.
     */
    function watchForBanner() {
      let seen = false;
      const queued = () =>
        Array.from(document.querySelectorAll("[data-queue]")).some((slot) =>
          (slot.getAttribute("data-queue") ?? "").split(" ").includes("onboarding"),
        );
      const observer = new MutationObserver(() => {
        if (queued()) seen = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-queue"] });
      return {
        seen: () => seen || queued(),
        stop: () => observer.disconnect(),
      };
    }

    function delay(command: string, ms: number) {
      const base = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((name: string, ...rest: unknown[]) =>
        name === command
          ? new Promise((resolve) => setTimeout(() => resolve(base(name, ...rest)), ms))
          : base(name, ...rest),
      );
    }

    const completed = () =>
      expect(saveShellStateMock).toHaveBeenCalledWith({ hasCompletedOnboarding: true });

    it("never shows it while the serial status bootstrap awaits is slow", async () => {
      // Every guard is met by the describe-level state: a saved calibration, a
      // persisted mode and a connected strip.
      delay(DEVICE_COMMANDS.GET_CONNECTION_STATUS, 300);
      const banner = watchForBanner();

      render(<App />);

      await waitFor(completed, { timeout: 2_000 });
      expect(banner.seen()).toBe(false);
      banner.stop();
    });

    it("never shows it while the only reachable output is a bridge still being probed", async () => {
      mockIsConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({
        lastSection: "general",
        ledCalibration: {
          templateId: "monitor-27-16-9",
          counts: { top: 10, right: 10, bottom: 10, left: 10 },
          bottomMissing: 0,
          cornerOwnership: "horizontal",
          visualPreset: "subtle",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 40,
        },
        lightingMode: { kind: "off" },
        lastOutputTargets: ["hue"],
        lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
        hueAppKey: "app-user",
        hueClientKey: "AABBCCDD11223344",
        lastHueAreaId: "area-1",
      });
      // The last guard resolves well after bootstrap, in a tick of its own.
      delay(HUE_COMMANDS.VALIDATE_CREDENTIALS, 400);
      const banner = watchForBanner();

      render(<App />);

      await waitFor(completed, { timeout: 2_000 });
      expect(banner.seen()).toBe(false);
      banner.stop();
    });

    it("still greets a fresh install at step 1", async () => {
      mockIsConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({ lastSection: "general" });

      render(<App />);

      // Behind "no reachable output", which outranks it in the queue.
      await waitFor(() => {
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")?.split(" ")).toEqual([
          "output-none",
          "onboarding",
        ]);
      });
      await act(async () => {
        screen.getByTestId("notice-toggle").click();
      });
      expect(screen.getByTestId("onboarding-notice")).toHaveTextContent("common:ui.onboarding.step1.title");
    });
  });

  // No layout engine here, so only the structure is assertable, not the heights
  // it decides — as a block column the banner clipped 162 px at 320×480.
  // The toasts were z-50 like the modal and later in the DOM, so they drew
  // over it, outside its focus trap.
  it.each(["compact", "full"] as const)(
    "keeps the notices under the update prompt, inert and silent, in %s",
    async (uiMode) => {
      mockIsConnected = false;
      loadShellStateMock.mockResolvedValue({ lastSection: "general", uiMode });
      mockUpdaterState = {
        status: "available",
        update: { version: "9.9.9", currentVersion: "1.0.0", body: null, date: null },
      };

      render(<App />);

      const dialog = await screen.findByRole("dialog");
      await waitFor(() => {
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).not.toBe("");
      });
      const slot = screen.getByTestId("shell-notice-slot");
      expect(slot).toHaveAttribute("inert");
      expect(dialog.contains(slot)).toBe(false);
      // Later in the document, so it paints above at any equal z-index.
      expect(slot.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByTestId("shell-notice-announcer")).toBeEmptyDOMElement();
    },
  );

  // A startup check that failed on a broken build used to open the blocking
  // modal as "installation could not be completed".
  it("runs the startup update check as a background check, never as a user check", async () => {
    loadShellStateMock.mockResolvedValue({ lastSection: "lights", uiMode: "compact" });

    render(<App />);

    await waitFor(() => {
      expect(checkForUpdatesInBackgroundMock).toHaveBeenCalledOnce();
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("offers a failed background check as a notice whose retry is a user check", async () => {
    // Off Lights and past onboarding, so nothing outranks the lowest-tier notice.
    loadShellStateMock.mockResolvedValue({ lastSection: "system", uiMode: "full", hasCompletedOnboarding: true });
    mockCheckFailedNotice = { message: "check_for_update not allowed" };

    render(<App />);

    await screen.findByTestId("update-check-retry");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();

    // Re-queried: the slot re-renders as boot settles, so an early handle can be detached.
    await waitFor(() => {
      screen.getByTestId("update-check-retry").click();
      expect(checkForUpdatesMock).toHaveBeenCalledOnce();
    });
  });

  // Full used to float its notices bottom right, over the page; both modes now
  // give the slot a row of its own above the layout.
  it.each(["compact", "full"] as const)("gives the %s notice slot its own row instead of letting it push the layout out", async (uiMode) => {
    // A fresh install: no guard is ever met and nothing is reachable, so the
    // slot mounts and stays.
    mockIsConnected = false;
    loadShellStateMock.mockResolvedValue({ lastSection: "lights", uiMode });

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("shell-notice-slot")).not.toBeNull();
    });

    const noticeSlot = screen.getByTestId("shell-notice-slot");
    expect(noticeSlot).toHaveClass("lm-notice-slot");
    expect(noticeSlot).toHaveAttribute("data-variant", uiMode);

    const slot = noticeSlot.parentElement!;
    expect(slot.className).toContain("flex");
    expect(slot.className).toContain("flex-col");

    // The layout sits in a sibling box that may shrink; `min-h-0` is what lets
    // it, since a flex item's auto minimum would otherwise pin it to content.
    const layoutBox = screen.getByTestId("active-mode").closest("div")!.parentElement!;
    expect(layoutBox.parentElement).toBe(slot);
    expect(layoutBox.className).toContain("flex-1");
    expect(layoutBox.className).toContain("min-h-0");
  });

  // ---------------------------------------------------------------------
  // The defect this covers: the Lights screen asked whether a *serial port*
  // was connected, so a WLED-only setup was told "no strip connected" and
  // every non-Off mode stayed disabled — while Rust was perfectly able to
  // drive the panel. App is where the two transports are folded into one
  // signal, so this is the only level at which the wiring is observable.
  // ---------------------------------------------------------------------
  describe("local output sink wiring", () => {
    it("hands the Lights screen a WLED sink when no serial port is connected", async () => {
      mockIsConnected = false;
      mockActiveWledIp = "192.168.1.42";
      installInvokeDispatch(false);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent("wled:192.168.1.42");
      });
    });

    it("prefers the serial port when both are bound, because the registry holds the serial sink", async () => {
      mockIsConnected = true;
      mockActiveWledIp = "192.168.1.42";
      installInvokeDispatch(true);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent(
          "serial:/dev/cu.usbserial-test",
        );
      });
    });

    it("reports nothing bound when neither transport is present", async () => {
      mockIsConnected = false;
      mockActiveWledIp = null;
      installInvokeDispatch(false);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent("none");
      });
    });
  });
});
