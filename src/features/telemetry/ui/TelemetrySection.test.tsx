import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "../../../shared/contracts/shell";
import { SettingsLayout } from "../../settings/SettingsLayout";

const getFullTelemetrySnapshotMock = vi.fn();

vi.mock("../telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
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
        "telemetry.hue.title": "Hue Stream",
        "telemetry.hue.status": "Status",
        "telemetry.hue.packetRate": "Packet Rate",
        "telemetry.hue.lastError": "Last Error",
        "telemetry.hue.reconnects": "Reconnects",
        "telemetry.hue.dtlsCipher": "DTLS Cipher",
        "telemetry.hue.connectionAge": "Connection Age",
        "settings.sections.lights": "Lights",
        "settings.sections.led-setup": "LED Setup",
        "settings.sections.devices": "Devices",
        "settings.sections.system": "System",
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
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: { captureFps: 60, sendFps: 58, queueHealth: "healthy" },
      hue: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches runtime telemetry on mount and renders capture/send/queue values", async () => {
    render(<TelemetrySection />);

    await waitFor(() => {
      expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
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
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    firstRender.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalled();

    render(<TelemetrySection />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(4);

    clearIntervalSpy.mockRestore();
  });

  it("renders Hue Stream section when hue telemetry is present", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: { captureFps: 60, sendFps: 58, queueHealth: "healthy" },
      hue: {
        state: "Running",
        uptimeSecs: 754,
        packetRate: 18.4,
        lastErrorCode: null,
        lastErrorAtSecs: null,
        totalReconnects: 0,
        successfulReconnects: 0,
        failedReconnects: 0,
        dtlsActive: true,
        dtlsCipher: "PSK-AES128-GCM-SHA256",
        dtlsConnectedAtSecs: 754,
      },
    });

    render(<TelemetrySection />);

    await waitFor(() => {
      expect(screen.getByText("Hue Stream")).toBeInTheDocument();
    });

    expect(screen.getByText("18.4 pkt/s")).toBeInTheDocument();
    expect(screen.getByText("PSK-AES128-GCM-SHA256")).toBeInTheDocument();
  });

  it("does not render Hue section when hue is null", async () => {
    render(<TelemetrySection />);

    await waitFor(() => {
      expect(screen.getByText("Capture FPS")).toBeInTheDocument();
    });

    expect(screen.queryByText("Hue Stream")).not.toBeInTheDocument();
  });

  it("renders error fallback when telemetry request fails", async () => {
    getFullTelemetrySnapshotMock.mockRejectedValueOnce(new Error("boom"));

    render(<TelemetrySection />);

    await waitFor(() => {
      expect(screen.getByText("Telemetry unavailable.")).toBeInTheDocument();
    });
  });
});

vi.mock("../../tray/trayController", () => ({
  getStartupEnabled: vi.fn().mockResolvedValue(false),
  listenStartupToggle: vi.fn().mockResolvedValue(() => {}),
  setStartupTrayChecked: vi.fn().mockResolvedValue(undefined),
  toggleStartup: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../i18n/i18n", () => ({
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  changeLanguage: vi.fn(),
}));

vi.mock("../../persistence/shellStore", () => ({
  shellStore: { save: vi.fn() },
}));

describe("Settings telemetry wiring", () => {
  it("renders TelemetrySection when system section is active", async () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.SYSTEM}
        onSectionChange={vi.fn()}
        calibrationStep="editor"
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onCalibrationSaved={vi.fn()}
        onCalibrationStepChange={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Runtime telemetry")).toBeInTheDocument();
    });
  });

  it("system nav button triggers section change to SYSTEM", async () => {
    const user = userEvent.setup();
    const onSectionChange = vi.fn();

    render(
      <SettingsLayout
        activeSection={SECTION_IDS.LIGHTS}
        onSectionChange={onSectionChange}
        calibrationStep="editor"
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onCalibrationSaved={vi.fn()}
        onCalibrationStepChange={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /System/i }));

    expect(onSectionChange).toHaveBeenCalledWith(SECTION_IDS.SYSTEM);
  });
});
