// The status bar with "Show stats for nerds" off and on, over the real
// telemetry hooks: the point of the setting is that off costs no IPC at all,
// so the poll is counted at the command bridge rather than assumed.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FullTelemetrySnapshot } from "@/shared/contracts/telemetry";

const { getFullTelemetrySnapshotMock, saveMock } = vi.hoisted(() => ({
  getFullTelemetrySnapshotMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: unknown) => saveMock(partial),
    onSaved: () => () => {},
  },
}));

import { __resetTelemetrySourceForTests } from "@/features/telemetry/telemetrySource";
import {
  __resetShowNerdStatsForTests,
  __setShowNerdStatsForTests,
  setShowNerdStats,
} from "@/features/telemetry/nerdStatsSetting";

import { StatusBar, type StatusItem } from "../StatusBar";

const ITEMS: StatusItem[] = [
  { label: "CAP", state: "OK", kind: "ok", nerdStat: true },
  { label: "USB", state: "OFF", kind: "off" },
  { label: "HUE", state: "IDLE", kind: "idle" },
];

const SNAPSHOT: FullTelemetrySnapshot = {
  usb: {
    captureFps: 58.4,
    sendFps: 58.1,
    queueHealth: "healthy",
    frameLatencyMs: 4.2,
    linkConstrained: false,
    linkMaxFps: 0,
    lastCaptureErrorCode: null,
    lastCaptureErrorAtSecs: null,
  },
  hue: null,
};

function renderBar() {
  return render(<StatusBar items={ITEMS} uiMode="full" lightingActive />);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("StatusBar — stats for nerds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetTelemetrySourceForTests();
    __resetShowNerdStatsForTests();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    getFullTelemetrySnapshotMock.mockResolvedValue(SNAPSHOT);
    saveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    __resetTelemetrySourceForTests();
    __resetShowNerdStatsForTests();
    vi.useRealTimers();
  });

  it("shows only the status chips when off, and queries no telemetry", async () => {
    renderBar();
    await advance(10_000);

    expect(screen.getByTestId("status-bar")).toHaveAttribute("data-nerd-stats", "off");
    expect(screen.getByTestId("status-chip-USB")).toBeInTheDocument();
    expect(screen.getByTestId("status-chip-HUE")).toBeInTheDocument();
    expect(screen.queryByTestId("status-chip-CAP")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-fps")).not.toBeInTheDocument();
    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();
  });

  it("shows CAP and the FPS pill when on, polling as before", async () => {
    __setShowNerdStatsForTests(true);
    renderBar();
    await advance(3_000);

    expect(screen.getByTestId("status-chip-CAP")).toBeInTheDocument();
    expect(screen.getByTestId("status-fps-value")).toHaveTextContent("58");
    expect(getFullTelemetrySnapshotMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("starts and stops the poll live as the setting flips, with no restart", async () => {
    renderBar();
    await advance(3_000);
    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();

    await act(async () => {
      await setShowNerdStats(true);
    });
    await advance(2_000);
    expect(screen.getByTestId("status-fps")).toBeInTheDocument();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalled();

    await act(async () => {
      await setShowNerdStats(false);
    });
    const callsWhenTurnedOff = getFullTelemetrySnapshotMock.mock.calls.length;
    await advance(10_000);

    expect(screen.queryByTestId("status-fps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-chip-CAP")).not.toBeInTheDocument();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(callsWhenTurnedOff);
    expect(saveMock).toHaveBeenNthCalledWith(1, { showNerdStats: true });
    expect(saveMock).toHaveBeenNthCalledWith(2, { showNerdStats: false });
  });
});
