// App's lighting wiring: every choice goes to the Rust transaction, the Hue
// chip reads the snapshot and the stream's health, the strip coming and going,
// and the local sink the Lights screen is handed.

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALIBRATION,
  PAIRED,
  bootDone,
  choices,
  env,
  getHueStreamStatusMock,
  hueChip,
  hueStatus,
  installInvokeDispatch,
  loadShellStateMock,
  nextApplyRuns,
  publish,
  releaseHueOutputMock,
  resetAppHarness,
  retuneLightingMock,
  saveShellStateMock,
  telemetryPolls,
} from "./support/appHarness";

// Every App.*.test.tsx registers the same mocks; see ./support/appHarness.tsx.
vi.mock("react-i18next", async () => (await import("./support/appHarness")).mockReactI18next);
vi.mock("@tauri-apps/api/core", async () => (await import("./support/appHarness")).mockTauriCore);
vi.mock("@tauri-apps/api/window", async () => (await import("./support/appHarness")).mockTauriWindow);
vi.mock("../features/tray/trayController", async () => (await import("./support/appHarness")).mockTrayController);
vi.mock("../features/tray/trayApi", async () => (await import("./support/appHarness")).mockTrayApi);
vi.mock("../features/updater/useAutoUpdater", async () => (await import("./support/appHarness")).mockAutoUpdater);
vi.mock("../features/shell/windowLifecycle", async () => (await import("./support/appHarness")).mockWindowLifecycle);
vi.mock("../features/device/useDeviceConnection", async () => (await import("./support/appHarness")).mockDeviceConnection);
vi.mock("../features/device/useWledSink", async () => (await import("./support/appHarness")).mockWledSink);
vi.mock("../features/calibration/state/entryFlow", async () => (await import("./support/appHarness")).mockEntryFlow);
vi.mock("../features/mode/state/modeGuard", async () => (await import("./support/appHarness")).mockModeGuard);
vi.mock("../features/mode/modeApi", async () => (await import("./support/appHarness")).mockModeApi);
vi.mock("../features/mode/lightingRuntimeEventsApi", async () => (await import("./support/appHarness")).mockLightingRuntimeEvents);
vi.mock("../features/telemetry/runtimeHealthEventsApi", async () => (await import("./support/appHarness")).mockRuntimeHealthEvents);
vi.mock("../features/shell/StatusBar", async () => (await import("./support/appHarness")).mockStatusBar);
vi.mock("../features/settings/SettingsLayout", async () => (await import("./support/appHarness")).mockSettingsLayout);

import App from "../App";
import { __resetHueReadCacheForTests } from "../features/hue/hueReadCache";
import { __resetRuntimeHealthForTests } from "../features/telemetry/runtimeHealthSource";

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level cache: without this a prior test's status leaks into the next one.
  __resetHueReadCacheForTests();
  // Module-level too: the listener is attached once, by the first App mount.
  __resetRuntimeHealthForTests();
  resetAppHarness();
});

describe("App lighting", () => {
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

    it("hands no settings re-dispatch to the layout: Rust re-applies a saved setting itself", async () => {
      render(<App />);
      await bootDone();

      const actions = Object.keys(env.lastLightingActions ?? {});
      for (const handler of [
        "onColorCorrectionChange",
        "onFirmwareProfileChange",
        "onChipTypeChange",
        "onColorOrderChange",
        "onSelectedDisplayIdChange",
        "onHueIntensityPresetChange",
      ]) {
        expect(env.lastLayoutProps[handler], handler).toBeUndefined();
      }
      // Nor through the lighting store the sections read instead of props.
      expect(actions.sort()).toEqual(["changeMode", "changeOutputTargets", "saveCalibration", "stopHueOutput"]);
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
      env.isConnected = false;
      installInvokeDispatch(false);
      loadShellStateMock.mockResolvedValue({ lastSection: "general", ...PAIRED, lastOutputTargets: ["hue"] });
      nextApplyRuns({ selectedTargets: ["hue"] });

      const { rerender } = render(<App />);
      await waitFor(() => expect(screen.getByTestId("output-targets")).toHaveTextContent("hue"));

      env.isConnected = true;
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

      env.isConnected = false;
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

      env.isConnected = false;
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

  // ---------------------------------------------------------------------
  // The defect this covers: the Lights screen asked whether a *serial port*
  // was connected, so a WLED-only setup was told "no strip connected" and
  // every non-Off mode stayed disabled — while Rust was perfectly able to
  // drive the panel. App is where the two transports are folded into one
  // signal, so this is the only level at which the wiring is observable.
  // ---------------------------------------------------------------------
  describe("local output sink wiring", () => {
    it("hands the Lights screen a WLED sink when no serial port is connected", async () => {
      env.isConnected = false;
      env.activeWledIp = "192.168.1.42";
      installInvokeDispatch(false);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent("wled:192.168.1.42");
      });
    });

    it("prefers the serial port when both are bound, because the registry holds the serial sink", async () => {
      env.isConnected = true;
      env.activeWledIp = "192.168.1.42";
      installInvokeDispatch(true);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent(
          "serial:/dev/cu.usbserial-test",
        );
      });
    });

    it("reports nothing bound when neither transport is present", async () => {
      env.isConnected = false;
      env.activeWledIp = null;
      installInvokeDispatch(false);

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("local-sink")).toHaveTextContent("none");
      });
    });
  });

  // The layout used to take every lighting value as a prop, two of them fresh
  // closures, so its memo never held and each App render re-rendered the page.
  describe("render boundary", () => {
    it("carries a runtime revision to the sections through the store, not by re-rendering the layout", async () => {
      nextApplyRuns({
        mode: { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.5 } },
        active: true,
        activeTargets: ["usb"],
      });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("solid"));
      // Let boot's own renders settle before counting.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const layoutBefore = env.layoutRenders;
      const probeBefore = env.layoutProbeRenders;
      const appBefore = env.statusBarRenders;

      publish({ mode: { kind: "ambilight", ambilight: { brightness: 0.6 } }, active: true });

      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight"));
      // App itself re-renders (the status bar reads the kind)…
      expect(env.statusBarRenders).toBeGreaterThan(appBefore);
      // …the store subscriber sees it…
      expect(env.layoutProbeRenders).toBeGreaterThan(probeBefore);
      // …and the layout, whose props are Hue status only, is not re-rendered.
      expect(env.layoutRenders).toBe(layoutBefore);
    });

    it("does not re-render the shell for a pushed runtime health that changes nothing it shows", async () => {
      nextApplyRuns({
        mode: { kind: "ambilight", ambilight: { brightness: 1 } },
        active: true,
        activeTargets: ["usb"],
      });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight"));
      await waitFor(() => expect(env.pushHealth).not.toBeNull());
      const appBefore = env.statusBarRenders;
      const layoutBefore = env.layoutRenders;
      const probeBefore = env.layoutProbeRenders;

      // A link budget moves the Lights note, not the shell's stall notice.
      act(() => {
        env.pushHealth?.({ captureFailureCode: null, linkConstrained: true, linkMaxFps: 23 });
      });

      expect(env.statusBarRenders).toBe(appBefore);
      expect(env.layoutRenders).toBe(layoutBefore);
      expect(env.layoutProbeRenders).toBe(probeBefore);
    });
  });

  describe("capture stall notice", () => {
    const stallQueue = () => screen.queryByTestId("shell-notice-slot")?.getAttribute("data-queue") ?? "";

    it("raises the stall from the worker's push and polls no telemetry for it", async () => {
      nextApplyRuns({
        mode: { kind: "ambilight", ambilight: { brightness: 1 } },
        active: true,
        activeTargets: ["usb"],
      });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("active-mode")).toHaveTextContent("ambilight"));
      await waitFor(() => expect(env.pushHealth).not.toBeNull());
      // Only the one read that seeds the listener.
      await waitFor(() => expect(telemetryPolls()).toBe(1));

      act(() => {
        env.pushHealth?.({
          captureFailureCode: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
          linkConstrained: false,
          linkMaxFps: 0,
        });
      });
      await waitFor(() => expect(stallQueue()).toContain("capture-stalled"));

      act(() => {
        env.pushHealth?.({ captureFailureCode: null, linkConstrained: false, linkMaxFps: 0 });
      });
      await waitFor(() => expect(stallQueue()).not.toContain("capture-stalled"));

      // The old stall check polled at 1 Hz; two of its ticks would land in this.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_200));
      });
      expect(telemetryPolls()).toBe(1);
    });
  });
});
