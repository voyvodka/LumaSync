import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import { HUE_COMMANDS, HUE_STATUS } from "@/shared/contracts/hue";
import type {
  ApplyOutputsOutcome,
  ApplyOutputsRequest,
  ApplyOutputsResult,
  LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";

const loadShellStateMock = vi.fn();
const saveShellStateMock = vi.fn();
const initWindowLifecycleMock = vi.fn();

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
// the UpdateModal mid-test. The modal is not under test in this file —
// stub the hook to a static idle state so updater behaviour stays out of
// the lighting assertions.
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
  startCalibrationFromSettings: () => ({ open: true, step: "editor" }),
}));

vi.mock("../features/mode/state/modeGuard", () => ({
  MODE_GUARD_REASONS: {
    CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
  },
  canEnableLedMode: () => ({ canEnable: true, reason: null }),
}));

const getHueStreamStatusMock = vi.fn();
const applyOutputsMock = vi.fn();
const retuneLightingMock = vi.fn();
const releaseHueOutputMock = vi.fn();
const getLightingRuntimeMock = vi.fn();

vi.mock("../features/mode/modeApi", () => ({
  applyOutputs: (request: ApplyOutputsRequest) => applyOutputsMock(request),
  retuneLighting: (tuning: unknown) => retuneLightingMock(tuning),
  releaseHueOutput: (trigger: string) => releaseHueOutputMock(trigger),
  getLightingRuntime: () => getLightingRuntimeMock(),
  getHueStreamStatus: () => getHueStreamStatusMock(),
  startHue: vi.fn(),
  restartHue: vi.fn(),
  acquireHueForTest: vi.fn(),
  releaseHueAfterTest: vi.fn(),
}));

let publishRuntime: ((snapshot: LightingRuntimeSnapshot) => void) | null = null;
vi.mock("../features/mode/lightingRuntimeEventsApi", () => ({
  listenLightingRuntime: (listener: (snapshot: LightingRuntimeSnapshot) => void) => {
    publishRuntime = listener;
    return Promise.resolve(() => {});
  },
}));

// StatusBar renders useRuntimeTelemetry which polls `get_runtime_telemetry`
// via invokeMock. Stubbing the entire StatusBar component is the cleanest
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

let lastLayoutProps: Record<string, unknown> = {};

// The layout reads lighting and navigation from the shell stores, as the real
// sections do; only the Hue status still arrives as props.
vi.mock("../features/settings/SettingsLayout", async () => {
  const { useLightingActions, useLightingControlState } = await import("../features/mode/state/lightingControl");
  const { useNavigationState } = await import("../features/shell/navigationStore");
  return {
    SettingsLayout: (props: { hueStreaming: boolean; hueReconnecting?: boolean }) => {
      lastLayoutProps = props as unknown as Record<string, unknown>;
      const lighting = useLightingControlState((state) => state);
      const actions = useLightingActions();
      const activeSection = useNavigationState((state) => state.activeSection);
      return (
        <div>
          <p data-testid="active-mode">{lighting.lightingMode.kind}</p>
          <p data-testid="active-section">{activeSection}</p>
          <p data-testid="hue-shown-state">
            {props.hueReconnecting ? "reconnecting" : props.hueStreaming ? "streaming" : "none"}
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
    },
  };
});

import App from "../App";
import { __resetHueReadCacheForTests } from "../features/hue/hueReadCache";

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

// ---------------------------------------------------------------------------
// The lighting backend: the runtime snapshot Rust publishes, and the replies of
// the transaction commands. Each test says what the next reply runs.
// ---------------------------------------------------------------------------

let revision = 0;
let runtime: LightingRuntimeSnapshot;

/** A fresh revision every time, whatever `overrides` carries over. */
function snapshot(overrides: Partial<LightingRuntimeSnapshot> = {}): LightingRuntimeSnapshot {
  revision += 1;
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
    revision,
  };
}

/** Rust publishes a new snapshot to every window. */
function publish(overrides: Partial<LightingRuntimeSnapshot>): LightingRuntimeSnapshot {
  runtime = snapshot({ ...runtime, ...overrides });
  act(() => {
    publishRuntime?.(runtime);
  });
  return runtime;
}

function reply(
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
function nextApplyRuns(
  overrides: Partial<LightingRuntimeSnapshot>,
  code = "OUTPUTS_APPLIED",
  outcome: Partial<ApplyOutputsOutcome> = {},
) {
  applyOutputsMock.mockImplementationOnce(() => {
    runtime = snapshot({ ...runtime, ...overrides });
    return Promise.resolve(reply(code, runtime, outcome));
  });
}

const choices = () => applyOutputsMock.mock.calls.map(([request]) => request as ApplyOutputsRequest);
const hueChip = () => screen.getByTestId("status-chip-HUE");
const bootDone = () =>
  waitFor(() => expect(choices().some((request) => request.origin === "boot")).toBe(true));

const CALIBRATION = {
  templateId: "monitor-27-16-9",
  counts: { top: 10, right: 10, bottom: 10, left: 10 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "subtle",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 40,
};

const PAIRED = {
  lastHueBridge: { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" },
  hueAppKey: "app-user",
  hueClientKey: "AABBCCDD11223344",
  lastHueAreaId: "area-1",
};

const hueStatus = (state: "Running" | "Reconnecting" | "Failed" | "Idle") => ({
  active: state === "Running",
  lastSolidColor: null,
  status: { state, code: `HUE_${state.toUpperCase()}`, message: state, details: null },
});

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level cache: without this a prior test's status leaks into the next one.
    __resetHueReadCacheForTests();
    vi.useRealTimers();
    mockIsConnected = true;
    mockActiveWledIp = null;
    mockUpdaterState = { status: "idle" };
    mockCheckFailedNotice = null;
    publishRuntime = null;
    lastLayoutProps = {};
    revision = 0;
    runtime = snapshot();
    installInvokeDispatch(true);
    getHueStreamStatusMock.mockResolvedValue(hueStatus("Idle"));
    getLightingRuntimeMock.mockImplementation(() => Promise.resolve(runtime));
    applyOutputsMock.mockImplementation(() => Promise.resolve(reply("OUTPUTS_APPLIED", runtime)));
    retuneLightingMock.mockResolvedValue({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
    releaseHueOutputMock.mockImplementation(() => Promise.resolve(reply("OUTPUTS_APPLIED", runtime)));
    loadShellStateMock.mockResolvedValue({
      lastSection: "general",
      ledCalibration: CALIBRATION,
      lightingMode: {
        kind: "solid",
        solid: { r: 1, g: 2, b: 3, brightness: 0.5 },
      },
    });
    initWindowLifecycleMock.mockResolvedValue(undefined);
    saveShellStateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the launch restore", () => {
    it("asks Rust once, and shows what it says runs", async () => {
      nextApplyRuns({
        mode: { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
        active: true,
        activeTargets: ["usb"],
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("solid"));
      expect(choices()).toEqual([{ origin: "boot" }]);
    });

    it("shows Off when Rust ran nothing, with the saved outputs still selected", async () => {
      nextApplyRuns({ selectedTargets: ["usb", "hue"] });

      render(<App />);

      await bootDone();
      await waitFor(() => expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue"));
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    it("says it waits for a bridge that still holds the last session, then drops the notice", async () => {
      render(<App />);
      await bootDone();

      publish({ bootHueRetry: "waiting" });
      await waitFor(() =>
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).toContain("hue-boot-retry"),
      );

      publish({ bootHueRetry: null });
      await waitFor(() =>
        // With nothing queued the slot is not mounted at all.
        expect(screen.queryByTestId("shell-notice-slot")?.getAttribute("data-queue") ?? "").not.toContain(
          "hue-boot-retry",
        ),
      );
    });
  });

  describe("choices go to the transaction, and nothing else", () => {
    it("sends a mode click as one apply_outputs and saves nothing itself", async () => {
      render(<App />);
      await bootDone();

      await act(async () => {
        screen.getByText("set-off").click();
      });

      await waitFor(() =>
        expect(choices()).toContainEqual({ mode: { kind: "off" }, origin: "user" }),
      );
      expect(saveShellStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ lightingMode: expect.anything() }));
    });

    it("sends an output toggle as one saved choice", async () => {
      render(<App />);
      await bootDone();

      await act(async () => {
        screen.getByText("set-both-targets").click();
      });

      await waitFor(() =>
        expect(choices()).toContainEqual({ targets: ["usb", "hue"], origin: "user" }),
      );
      expect(saveShellStateMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastOutputTargets: expect.anything() }),
      );
    });

    it("sends the Devices card's Hue stop as a release", async () => {
      render(<App />);
      await bootDone();

      await act(async () => {
        screen.getByText("device-stop-hue").click();
      });

      await waitFor(() => expect(releaseHueOutputMock).toHaveBeenCalledWith("device_surface"));
    });

    it("routes a calibration refusal to LED Setup", async () => {
      render(<App />);
      await bootDone();
      nextApplyRuns({}, "OUTPUTS_CALIBRATION_REQUIRED");

      await act(async () => {
        screen.getByText("set-ambilight").click();
      });

      await waitFor(() => expect(screen.getByTestId("active-section")).toHaveTextContent("led-setup"));
    });

    it("hands no settings re-dispatch to the layout: Rust re-applies a saved setting itself", async () => {
      render(<App />);
      await bootDone();

      for (const handler of [
        "onColorCorrectionChange",
        "onFirmwareProfileChange",
        "onChipTypeChange",
        "onColorOrderChange",
        "onSelectedDisplayIdChange",
        "onHueIntensityPresetChange",
      ]) {
        expect(lastLayoutProps[handler], handler).toBeUndefined();
      }
    });
  });

  /**
   * On hardware the old orchestrator sent `set_lighting_mode` 68 times in a
   * session, twenty of them in one second. A nudge within the running kind is
   * now a retune — coalesced and deduped — and never a mode apply.
   */
  describe("no storm", () => {
    it("turns repeated identical updates into one retune and no apply", async () => {
      nextApplyRuns({
        mode: { kind: "ambilight", ambilight: { brightness: 1 } },
        active: true,
        activeTargets: ["usb"],
      });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight"));

      for (const label of ["set-ambilight", "set-ambilight-reordered", "set-ambilight", "set-ambilight-reordered"]) {
        await act(async () => {
          screen.getByText(label).click();
        });
      }

      await waitFor(() => expect(retuneLightingMock).toHaveBeenCalledTimes(1));
      expect(choices()).toEqual([{ origin: "boot" }]);
    });
  });

  describe("the Hue chip reads the snapshot and the stream's health", () => {
    it("calls a driven, running stream streaming", async () => {
      loadShellStateMock.mockResolvedValue({ lastSection: "general", ...PAIRED, lastOutputTargets: ["hue"] });
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Running"));
      nextApplyRuns({
        mode: { kind: "ambilight", targets: ["hue"] },
        active: true,
        activeTargets: ["hue"],
        selectedTargets: ["hue"],
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("streaming"));
    });

    it("reads a retrying bridge as reconnecting, not streaming", async () => {
      loadShellStateMock.mockResolvedValue({ lastSection: "general", ...PAIRED, lastOutputTargets: ["hue"] });
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Reconnecting"));
      nextApplyRuns({
        mode: { kind: "ambilight", targets: ["hue"] },
        active: true,
        activeTargets: ["hue"],
        selectedTargets: ["hue"],
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("reconnecting"));
    });

    it("does not call a stream the backend reports dead a session", async () => {
      loadShellStateMock.mockResolvedValue({ lastSection: "general", ...PAIRED, lastOutputTargets: ["hue"] });
      getHueStreamStatusMock.mockResolvedValue(hueStatus("Failed"));
      nextApplyRuns({
        mode: { kind: "ambilight", targets: ["hue"] },
        active: true,
        activeTargets: ["hue"],
        selectedTargets: ["hue"],
      });

      render(<App />);

      await waitFor(() => expect(getHueStreamStatusMock).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId("hue-shown-state")).toHaveTextContent("none"));
      // The health poll only reads: the re-apply it used to force was redundant.
      expect(choices()).toEqual([{ origin: "boot" }]);
    });

    it("shows Hue held out of a running mode on the chip", async () => {
      loadShellStateMock.mockResolvedValue({
        lastSection: "general",
        ledCalibration: CALIBRATION,
        ...PAIRED,
        lastOutputTargets: ["usb", "hue"],
      });
      nextApplyRuns({
        mode: { kind: "ambilight", targets: ["usb"] },
        active: true,
        activeTargets: ["usb"],
        selectedTargets: ["usb"],
        hueHeldOutReason: "unreachable",
      });

      render(<App />);

      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight"));
      expect(hueChip().textContent).not.toBe("");
      await waitFor(() =>
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).toContain("hue-left-out"),
      );
    });
  });

  describe("the strip coming and going", () => {
    it("adds a paired strip as a saved choice", async () => {
      mockIsConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({ lastSection: "general", ...PAIRED, lastOutputTargets: ["hue"] });
      nextApplyRuns({ selectedTargets: ["hue"] });

      const { rerender } = render(<App />);
      await waitFor(() => expect(screen.getByTestId("output-targets")).toHaveTextContent("hue"));

      mockIsConnected = true;
      await act(async () => {
        rerender(<App />);
      });

      await waitFor(() =>
        expect(choices()).toContainEqual({ targets: ["usb", "hue"], origin: "user" }),
      );
    });

    it("drops an unplugged strip for the session only, and says the rest carries on", async () => {
      loadShellStateMock.mockResolvedValue({
        lastSection: "general",
        ledCalibration: CALIBRATION,
        ...PAIRED,
        lastOutputTargets: ["usb", "hue"],
      });
      nextApplyRuns({
        mode: { kind: "ambilight", targets: ["usb", "hue"] },
        active: true,
        activeTargets: ["usb", "hue"],
        selectedTargets: ["usb", "hue"],
      });

      const { rerender } = render(<App />);
      await waitFor(() => expect(screen.getByTestId("output-targets")).toHaveTextContent("usb,hue"));

      mockIsConnected = false;
      await act(async () => {
        rerender(<App />);
      });

      await waitFor(() => expect(choices()).toContainEqual({ targets: ["hue"], origin: "usbUnplug" }));
    });

    it("ends a mode that ran on the strip alone, and says so", async () => {
      nextApplyRuns({
        mode: { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
        active: true,
        activeTargets: ["usb"],
        selectedTargets: ["usb"],
      });
      const { rerender } = render(<App />);
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("solid"));
      nextApplyRuns({ mode: { kind: "off" }, active: false, activeTargets: [] }, "OUTPUTS_APPLIED", {
        modeEnded: true,
      });

      mockIsConnected = false;
      await act(async () => {
        rerender(<App />);
      });

      await waitFor(() => expect(choices()).toContainEqual({ targets: [], origin: "usbUnplug" }));
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("off"));
      await waitFor(() =>
        expect(screen.getByTestId("shell-notice-slot").getAttribute("data-queue")).toContain("usb-disconnected"),
      );
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
      expect(screen.getByTestId("onboarding-notice")).toHaveTextContent("shell:notices.messages.onboarding.lights");
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
