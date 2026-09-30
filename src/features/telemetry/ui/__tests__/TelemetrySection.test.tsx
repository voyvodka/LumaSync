import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "@/shared/contracts/shell";
import { SettingsLayout } from "@/features/settings/SettingsLayout";
import { renderWithShellStores } from "@/test/shellProviders";

const getFullTelemetrySnapshotMock = vi.fn<typeof telemetryApiModule.getFullTelemetrySnapshot>();

const getRuntimeTelemetryHistoryMock = vi.fn<typeof telemetryApiModule.getRuntimeTelemetryHistory>();

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
  getRuntimeTelemetryHistory: () => getRuntimeTelemetryHistoryMock(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "telemetry:capture": "Screen capture",
        "telemetry:send": "Sent to the strip",
        "telemetry:queue": "Send queue",
        "telemetry:linkLimit": "Link limit",
        "telemetry:hueStream": "Hue stream",
        "telemetry:huePackets": "Hue packets",
        "telemetry:hueLastError": "Last Hue error",
        "telemetry:hueReconnects": "Hue reconnects",
        "telemetry:fps": "{{fps}} fps",
        "telemetry:fpsOf": "{{fps}} / {{target}} fps",
        "telemetry:packetRate": "{{rate}} per second",
        "telemetry:uptimeMinutes": "{{minutes}} min",
        "telemetry:uptimeSeconds": "{{seconds}} s",
        "telemetry:reconnectsFailed": "{{total}} · {{failed}} failed",
        "telemetry:notRunning": "Not running",
        "telemetry:none": "None",
        "telemetry:unmeasured": "Not measured",
        "telemetry:error": "Couldn't read the numbers",
        "telemetry:queueHealth.healthy": "Healthy",
        "telemetry:historySummary": "avg {{avg}} · low {{min}}",
        "telemetry:historyEmpty": "No readings yet",
        "telemetry:historyTarget": "target {{fps}}",
        "telemetry:historyLabel": "Capture rate: average {{avg}} fps, lowest {{min}} fps",
        "hue:runtime.states.Running": "Running",
        "settings:language.label": "Interface language",
      };
      const template = dict[key] ?? (typeof opts?.defaultValue === "string" ? opts.defaultValue : key);
      if (!opts) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts[name] ?? ""));
    },
  }),
}));

import { TelemetrySection } from "../TelemetrySection";
import { __resetTelemetrySourceForTests } from "../../telemetrySource";
import { __resetPreferencesForTests } from "@/features/persistence/preferences";
import type * as telemetryApiModule from "@/features/telemetry/telemetryApi";
import type { HueTelemetrySnapshot, RuntimeTelemetrySnapshot } from "@/shared/contracts/telemetry";

// Every field Rust sends; a test overrides only what it is about.
function usbSnapshot(overrides: Partial<RuntimeTelemetrySnapshot>): RuntimeTelemetrySnapshot {
  return {
    captureFps: 0,
    sendFps: 0,
    queueHealth: "healthy",
    frameLatencyMs: 0,
    linkConstrained: false,
    linkMaxFps: 0,
    lastCaptureErrorCode: null,
    lastCaptureErrorAtSecs: null,
    captureTargetFps: 0,
    ...overrides,
  };
}

function hueSnapshot(overrides: Partial<HueTelemetrySnapshot>): HueTelemetrySnapshot {
  return {
    state: "Running",
    uptimeSecs: 128,
    packetRate: 20,
    lastErrorCode: null,
    lastErrorAtSecs: null,
    totalReconnects: 0,
    successfulReconnects: 0,
    failedReconnects: 0,
    dtlsActive: true,
    dtlsCipher: "TLS_PSK_WITH_AES_128_GCM_SHA256",
    dtlsConnectedAtSecs: 128,
    ...overrides,
  };
}

const value = (id: string) => screen.getByTestId(`telemetry-${id}`).querySelector("dd")?.textContent;
const rowIds = () => [...screen.getByTestId("telemetry-readout").querySelectorAll("[data-testid^=telemetry-]")].map((el) => el.getAttribute("data-testid"));
const list = () => screen.getByTestId("telemetry-readout");

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TelemetrySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTelemetrySourceForTests();
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: usbSnapshot({ captureFps: 59.6, sendFps: 58.2, linkMaxFps: 74 }),
      hue: null,
    });
    getRuntimeTelemetryHistoryMock.mockResolvedValue({ samples: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    __resetTelemetrySourceForTests();
  });

  it("holds the values hidden in place until the first reading, then shows them in whole fps", async () => {
    let resolve: (snapshot: Awaited<ReturnType<typeof getFullTelemetrySnapshotMock>>) => void = () => {};
    getFullTelemetrySnapshotMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<TelemetrySection open localOutputConnected />);

    expect(list()).not.toHaveAttribute("data-ready");
    const before = rowIds();

    await act(async () => {
      resolve({ usb: usbSnapshot({ captureFps: 59.6, sendFps: 58.2, linkMaxFps: 74 }), hue: null });
    });

    expect(list()).toHaveAttribute("data-ready");
    expect(rowIds()).toEqual(before);
    expect(value("capture")).toBe("60 fps");
    expect(value("send")).toBe("58 fps");
    expect(value("queue")).toBe("Healthy");
    expect(value("link")).toBe("74 fps");
  });

  it("picks its rows from what is connected when it opens, so Hue data arriving adds none", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValueOnce({ usb: usbSnapshot({ captureFps: 60 }), hue: null });
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: usbSnapshot({ captureFps: 60 }),
      hue: hueSnapshot({ failedReconnects: 1, totalReconnects: 3 }),
    });
    vi.useFakeTimers();
    render(<TelemetrySection open localOutputConnected={false} hueActive />);
    const atOpen = rowIds();
    expect(atOpen).toEqual([
      "telemetry-capture",
      "telemetry-history",
      "telemetry-hue-stream",
      "telemetry-hue-packets",
      "telemetry-hue-error",
      "telemetry-hue-reconnects",
    ]);

    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(rowIds()).toEqual(atOpen);
    expect(value("hue-stream")).toBe("Running · 2 min");
    expect(value("hue-packets")).toBe("20 per second");
    expect(value("hue-error")).toBe("None");
    expect(value("hue-reconnects")).toBe("3 · 1 failed");
  });

  it("reads capture against the rate it was asked for once a worker said one", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: usbSnapshot({ captureFps: 15.4, captureTargetFps: 20 }),
      hue: null,
    });
    render(<TelemetrySection open localOutputConnected />);

    await waitFor(() => expect(value("capture")).toBe("15 / 20 fps"));
  });

  it("reads a strip without a serial link budget as not measured, never 0 fps", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue({ usb: usbSnapshot({ captureFps: 60 }), hue: null });
    render(<TelemetrySection open localOutputConnected />);
    await waitFor(() => expect(list()).toHaveAttribute("data-ready"));

    expect(value("link")).toBe("—Not measured");
  });

  it("with no output still reads the history, since it outlives the lights, and says capture is not running", async () => {
    render(<TelemetrySection open localOutputConnected={false} />);
    expect(value("capture")).toBe("Not running");
    await flush();

    expect(list()).toHaveAttribute("data-ready");
    expect(getRuntimeTelemetryHistoryMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("telemetry-history")).toHaveTextContent("No readings yet");
  });

  it("waits for the history as well as the numbers before showing either", async () => {
    let resolve: (history: { samples: [] }) => void = () => {};
    getRuntimeTelemetryHistoryMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<TelemetrySection open localOutputConnected />);
    await flush();

    expect(list()).not.toHaveAttribute("data-ready");
    await act(async () => {
      resolve({ samples: [] });
    });
    expect(list()).toHaveAttribute("data-ready");
  });

  it("draws the history under the capture row with its average, low and target", async () => {
    const now = Date.now();
    getRuntimeTelemetryHistoryMock.mockResolvedValue({
      samples: [18, 20, 12].map((fps, i) => ({ epochMs: now - (3 - i) * 1000, fps, targetFps: 20 })),
    });
    render(<TelemetrySection open localOutputConnected />);

    const chart = await screen.findByTestId("telemetry-history");
    await waitFor(() => expect(chart).toHaveTextContent("avg 17 · low 12"));
    expect(chart).toHaveTextContent("target 20");
    expect(rowIds().slice(0, 3)).toEqual(["telemetry-capture", "telemetry-history", "telemetry-send"]);
  });

  it("says so when the numbers cannot be read", async () => {
    getFullTelemetrySnapshotMock.mockRejectedValueOnce(new Error("boom"));
    render(<TelemetrySection open localOutputConnected />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the numbers");
    expect(list()).toHaveAttribute("data-ready");
  });

  it("closing keeps the last values while it folds away, then unmounts them and stops polling", async () => {
    vi.useFakeTimers();
    const view = render(<TelemetrySection open localOutputConnected />);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    view.rerender(<TelemetrySection open={false} localOutputConnected />);
    expect(value("capture")).toBe("60 fps");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByTestId("telemetry-readout")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("stops polling on unmount and starts afresh on remount", async () => {
    vi.useFakeTimers();
    const first = render(<TelemetrySection open localOutputConnected />);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    render(<TelemetrySection open localOutputConnected />);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);
  });
});

vi.mock("@/features/tray/trayController", () => ({
  getStartupEnabled: vi.fn().mockResolvedValue(false),
  setStartup: vi.fn<(enabled: boolean) => Promise<boolean>>().mockResolvedValue(true),
}));

vi.mock("@/features/i18n/i18n", () => ({
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  I18N_LANGUAGE_NAMES: { en: "English", tr: "Türkçe" },
  changeLanguage: vi.fn(),
}));

const { shellSaveMock } = vi.hoisted(() => ({ shellSaveMock: vi.fn() }));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    save: (partial: unknown) => shellSaveMock(partial),
    load: () => Promise.resolve({}),
    onSaved: () => () => {},
  },
}));

const SYSTEM_SECTION = {
  navigation: { uiMode: "full" as const, activeSection: SECTION_IDS.SYSTEM },
  lighting: { localSink: { transport: "serial" as const, id: "/dev/cu.usbserial-1420" } },
};

describe("Settings telemetry wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTelemetrySourceForTests();
    __resetPreferencesForTests();
    shellSaveMock.mockResolvedValue(undefined);
    getRuntimeTelemetryHistoryMock.mockResolvedValue({ samples: [] });
    getFullTelemetrySnapshotMock.mockResolvedValue({
      usb: usbSnapshot({ captureFps: 60, sendFps: 58 }),
      hue: null,
    });
  });

  afterEach(() => {
    cleanup();
    __resetTelemetrySourceForTests();
    __resetPreferencesForTests();
  });

  async function openAppearance() {
    const page = await screen.findByTestId("settings-page-appearance");
    await act(async () => {
      page.click();
    });
  }

  it("keeps the readout unmounted, and polls nothing, with stats for nerds off", async () => {
    renderWithShellStores(<SettingsLayout />, SYSTEM_SECTION);
    await openAppearance();

    const toggle = await screen.findByTestId("nerd-stats-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("telemetry-readout")).not.toBeInTheDocument();
    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();
  });

  it("turning it on shows the readout, starts the poll and saves the choice", async () => {
    renderWithShellStores(<SettingsLayout />, SYSTEM_SECTION);
    await openAppearance();
    const toggle = await screen.findByTestId("nerd-stats-toggle");

    await act(async () => {
      toggle.click();
    });

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(shellSaveMock).toHaveBeenCalledWith({ showNerdStats: true });
    await waitFor(() => expect(screen.getByText("60 fps")).toBeInTheDocument());
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalled();
  });

  it("keeps stats for nerds on the Appearance page, not on the first one", async () => {
    renderWithShellStores(<SettingsLayout />, SYSTEM_SECTION);

    await screen.findByTestId("settings-page-general");
    expect(screen.queryByTestId("nerd-stats-toggle")).not.toBeInTheDocument();
    await openAppearance();
    expect(await screen.findByTestId("nerd-stats-toggle")).toBeInTheDocument();
  });

  // The picker moved from a two-button segmented control to a dropdown so more
  // locales can be added without the row outgrowing its width.
  it("offers every supported language by endonym, side by side", async () => {
    renderWithShellStores(<SettingsLayout />, SYSTEM_SECTION);

    const picker = await screen.findByRole("radiogroup", { name: "Interface language" });
    const options = within(picker).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["English", "Türkçe"]);
    // By its own name, never a code.
    expect(screen.queryByRole("radio", { name: "EN" })).not.toBeInTheDocument();
  });
});
