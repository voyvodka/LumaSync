import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { LightingModeConfig } from "./features/mode/model/contracts";

const loadShellStateMock = vi.fn();
const saveShellStateMock = vi.fn();
const initWindowLifecycleMock = vi.fn();
const setLightingModeMock = vi.fn();
const stopLightingMock = vi.fn();

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
}));

vi.mock("./features/calibration/ui/CalibrationOverlay", () => ({
  CalibrationOverlay: () => null,
}));

vi.mock("./features/settings/SettingsLayout", () => ({
  SettingsLayout: (props: {
    lightingMode: LightingModeConfig;
    onLightingModeChange: (mode: LightingModeConfig) => void;
  }) => (
    <div>
      <p data-testid="active-mode">{props.lightingMode.kind}</p>
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
});
