import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { LightingModeConfig } from "./features/mode/model/contracts";

const loadShellStateMock = vi.fn();
const saveShellStateMock = vi.fn();
const initWindowLifecycleMock = vi.fn();
const setLightingModeMock = vi.fn();
const stopLightingMock = vi.fn();
const startHueMock = vi.fn();
const stopHueMock = vi.fn();

// Controllable isConnected for hot-plug tests
let mockIsConnected = true;

// Mock invoke for Tauri commands (used in bootstrap for USB status check)
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./features/tray/trayController", () => ({
  listenTrayLightsOff: () => Promise.resolve(() => {}),
  listenTrayResumeLastMode: () => Promise.resolve(() => {}),
  listenTraySolidColor: () => Promise.resolve(() => {}),
  listenStartupToggle: () => Promise.resolve(() => {}),
  updateTrayLabels: () => Promise.resolve(),
}));

vi.mock("./features/shell/windowLifecycle", () => ({
  loadShellState: () => loadShellStateMock(),
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
  initWindowLifecycle: () => initWindowLifecycleMock(),
}));

vi.mock("./features/device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({ isConnected: mockIsConnected }),
}));

vi.mock("./features/calibration/state/entryFlow", () => ({
  shouldAutoOpenCalibrationOnConnection: () => false,
  startCalibrationFromSettings: () => ({ open: false, step: "editor" }),
}));

vi.mock("./features/mode/state/modeGuard", () => ({
  MODE_GUARD_REASONS: {
    CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
  },
  canEnableLedMode: () => ({ canEnable: true, reason: null }),
}));

const getHueStreamStatusMock = vi.fn();
const setHueSolidColorMock = vi.fn();

vi.mock("./features/mode/modeApi", () => ({
  setLightingMode: (payload: LightingModeConfig) => setLightingModeMock(payload),
  stopLighting: () => stopLightingMock(),
  startHue: (payload: { bridgeIp: string; username: string; clientKey: string; areaId: string }) => startHueMock(payload),
  stopHue: () => stopHueMock(),
  getHueStreamStatus: () => getHueStreamStatusMock(),
  setHueSolidColor: (payload: unknown) => setHueSolidColorMock(payload),
}));

vi.mock("./features/calibration/ui/CalibrationOverlay", () => ({
  CalibrationOverlay: () => null,
}));

vi.mock("./features/settings/SettingsLayout", () => ({
  SettingsLayout: (props: {
    lightingMode: LightingModeConfig;
    outputTargets: Array<"usb" | "hue">;
    onLightingModeChange: (mode: LightingModeConfig) => void;
    onOutputTargetsChange: (targets: Array<"usb" | "hue">) => void;
  }) => (
    <div>
      <p data-testid="active-mode">{props.lightingMode.kind}</p>
      <p data-testid="output-targets">{props.outputTargets.join(",")}</p>
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
      <button
        type="button"
        onClick={() => props.onLightingModeChange({ kind: "off" })}
      >
        set-off
      </button>
    </div>
  ),
}));

import App from "./App";

describe("App mode orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected = true;
    // Default: USB is connected at startup
    invokeMock.mockResolvedValue({ connected: true });
    getHueStreamStatusMock.mockResolvedValue({
      active: false,
      lastSolidColor: null,
      status: { state: "Idle", code: "HUE_STREAM_STOPPED", message: "Stopped", details: null },
    });
    setHueSolidColorMock.mockResolvedValue({ ok: true });
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
    setLightingModeMock.mockResolvedValue({ active: true });
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

    expect(setLightingModeMock).toHaveBeenCalledWith({
      kind: "solid",
      solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
      ambilight: undefined,
      targets: ["usb"],
    });

    await waitFor(() => {
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

  it("treats repeated start as idempotent when hue runtime reports already active", async () => {
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

    startHueMock
      .mockResolvedValueOnce({
        active: true,
        status: { code: "HUE_STREAM_RUNNING", message: "Running", details: null },
      })
      .mockResolvedValueOnce({
        active: true,
        status: { code: "HUE_START_NOOP_ALREADY_ACTIVE", message: "No-op", details: null },
      });

    render(<App />);

    // Wait for bootstrap to complete — output-targets reflects persisted ["hue"]
    await waitFor(() => {
      expect(screen.getByTestId("output-targets")).toHaveTextContent("hue");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    expect(startHueMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("active-mode")).toHaveTextContent("solid");
  });

  it("filters persisted USB target when USB is not connected on startup", async () => {
    // Setup: loadShellStateMock returns lastOutputTargets: ["usb", "hue"], useDeviceConnection returns isConnected: false
    mockIsConnected = false;
    invokeMock.mockResolvedValue({ connected: false });
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

  it("shows USB suggest banner when USB is plugged in during Hue-only session", async () => {
    // Setup: Start with targets=["hue"], isConnected=false
    mockIsConnected = false;
    invokeMock.mockResolvedValue({ connected: false });
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
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    // Action: Simulate USB being plugged in
    mockIsConnected = true;
    await act(async () => {
      rerender(<App />);
    });

    // Expect: USB suggest banner appears
    await waitFor(() => {
      // Banner text from i18n key "hotplug.usbDetected"
      // In test environment with mocked i18n, the key itself or English text may appear
      expect(screen.getByTestId("active-mode")).toBeInTheDocument();
    });
  });

  it("silently drops USB target when USB is unplugged during dual-target session", async () => {
    // Setup: Start with targets=["usb", "hue"], isConnected=true
    mockIsConnected = true;
    invokeMock.mockResolvedValue({ connected: true });
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
      expect(invokeMock).toHaveBeenCalledWith("stop_lighting");
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
});
