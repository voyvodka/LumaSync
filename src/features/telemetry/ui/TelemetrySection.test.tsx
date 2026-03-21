import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      };

      return dict[key] ?? key;
    },
  }),
}));

import { TelemetrySection } from "./TelemetrySection";

describe("TelemetrySection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getRuntimeTelemetrySnapshotMock.mockResolvedValue({
      captureFps: 60,
      sendFps: 58,
      queueHealth: "healthy",
    });
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
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const firstRender = render(<TelemetrySection />);

    await waitFor(() => {
      expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(750);
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    firstRender.unmount();

    await vi.advanceTimersByTimeAsync(1500);
    expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalled();

    render(<TelemetrySection />);
    await waitFor(() => {
      expect(getRuntimeTelemetrySnapshotMock).toHaveBeenCalledTimes(3);
    });

    await vi.advanceTimersByTimeAsync(750);
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
