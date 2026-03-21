import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "../../../shared/contracts/shell";
import { SettingsLayout } from "../../settings/SettingsLayout";

const getRuntimeTelemetrySnapshotMock = vi.fn();

vi.mock("../telemetryApi", () => ({
  getRuntimeTelemetrySnapshot: () => getRuntimeTelemetrySnapshotMock(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "telemetry.title": "Runtime telemetry",
        "telemetry.description": "Live runtime quality metrics.",
        "telemetry.metrics.captureFps": "Capture FPS",
        "telemetry.metrics.sendFps": "Send FPS",
        "telemetry.metrics.queueHealth": "Queue health",
        "telemetry.queueHealth.healthy": "Healthy",
        "telemetry.queueHealth.warning": "Warning",
        "telemetry.queueHealth.critical": "Critical",
        "telemetry.states.loading": "Loading telemetry...",
        "telemetry.states.empty": "No runtime activity yet.",
        "telemetry.states.error": "Telemetry unavailable.",
        "settings.sections.general": "General",
        "settings.sections.startupTray": "Startup & Tray",
        "settings.sections.language": "Language",
        "settings.sections.aboutLogs": "About & Logs",
        "settings.sections.telemetry": "Telemetry",
        "settings.sections.device": "Device",
        "settings.sections.calibration": "Calibration",
        "general.title": "General",
        "general.description": "General application settings.",
        "general.mode.title": "LED mode",
        "general.mode.description": "Choose output mode.",
        "general.mode.options.off": "Off",
        "general.mode.options.ambilight": "Ambilight",
        "general.mode.options.solid": "Solid",
        "general.mode.brightness": "Brightness",
        "general.mode.solidColor": "Solid color",
      };

      return dict[key] ?? key;
    },
  }),
}));

import { TelemetrySection } from "./TelemetrySection";

describe("TelemetrySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRuntimeTelemetrySnapshotMock.mockResolvedValue({
      captureFps: 60,
      sendFps: 58,
      queueHealth: "healthy",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches runtime telemetry on mount and renders capture/send/queue values", async () => {
    render(<TelemetrySection />);

    await waitFor(() => {
      expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText("Capture FPS")).toBeInTheDocument();
    expect(screen.getByText("60.00")).toBeInTheDocument();
    expect(screen.getByText("Send FPS")).toBeInTheDocument();
    expect(screen.getByText("58.00")).toBeInTheDocument();
    expect(screen.getByText("Queue health")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("cleans polling interval on unmount and does not duplicate interval after remount", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const firstRender = render(<TelemetrySection />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    firstRender.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalled();

    render(<TelemetrySection />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(4);

    clearIntervalSpy.mockRestore();
  });

  it("renders error fallback when telemetry request fails", async () => {
    getRuntimeTelemetrySnapshotMock.mockRejectedValueOnce(new Error("boom"));

    render(<TelemetrySection />);

    await waitFor(() => {
      expect(screen.getByText("Telemetry unavailable.")).toBeInTheDocument();
    });
  });
});

describe("Settings telemetry wiring", () => {
  it("renders TelemetrySection content when telemetry section is active", async () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.TELEMETRY}
        onSectionChange={vi.fn()}
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onEditCalibration={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Runtime telemetry" })).toBeInTheDocument();
    });
  });

  it("preserves existing default section flow while telemetry tab remains selectable", async () => {
    const user = userEvent.setup();
    const onSectionChange = vi.fn();

    render(
      <SettingsLayout
        activeSection={SECTION_IDS.GENERAL}
        onSectionChange={onSectionChange}
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onEditCalibration={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Telemetry" }));

    expect(onSectionChange).toHaveBeenCalledWith(SECTION_IDS.TELEMETRY);
    expect(screen.queryByRole("heading", { name: "Runtime telemetry" })).not.toBeInTheDocument();
  });
});
