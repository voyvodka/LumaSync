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

vi.mock("./features/shell/windowLifecycle", () => ({
  loadShellState: () => loadShellStateMock(),
  saveShellState: (patch: unknown) => saveShellStateMock(patch),
  initWindowLifecycle: () => initWindowLifecycleMock(),
}));

vi.mock("./features/device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({ isConnected: true }),
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

vi.mock("./features/mode/modeApi", () => ({
  setLightingMode: (payload: LightingModeConfig) => setLightingModeMock(payload),
  stopLighting: () => stopLightingMock(),
  startHue: (payload: { bridgeIp: string; username: string; areaId: string }) => startHueMock(payload),
  stopHue: () => stopHueMock(),
}));

vi.mock("./features/calibration/ui/CalibrationOverlay", () => ({
  CalibrationOverlay: () => null,
}));

vi.mock("./features/settings/SettingsLayout", () => ({
  SettingsLayout: (props: {
    lightingMode: LightingModeConfig;
    onLightingModeChange: (mode: LightingModeConfig) => void;
    onOutputTargetsChange: (targets: Array<"usb" | "hue">) => void;
  }) => (
    <div>
      <p data-testid="active-mode">{props.lightingMode.kind}</p>
      <button
        type="button"
        onClick={() => props.onOutputTargetsChange(["hue"])}
      >
        set-hue-target
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
    });

    expect(saveShellStateMock).toHaveBeenCalledWith({
      lightingMode: {
        kind: "solid",
        solid: { r: 10, g: 20, b: 30, brightness: 0.8 },
      },
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
      lastHueAreaId: "area-1",
    });

    startHueMock.mockResolvedValueOnce({
      active: false,
      status: { code: "CONFIG_NOT_READY_GATE_BLOCKED", message: "Gate blocked", details: "readiness" },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
    });

    await act(async () => {
      screen.getByRole("button", { name: "set-solid" }).click();
    });

    expect(startHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.10",
      username: "app-user",
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

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
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
      lastHueAreaId: "area-1",
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("active-mode")).toHaveTextContent("off");
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
