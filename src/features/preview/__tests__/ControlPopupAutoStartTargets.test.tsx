// The popup's auto-start fires on reveal with no user gesture, so it must never
// light Hue: it targets the strip ("usb", which also covers WLED) and nothing
// else. Driven through the real popup, runner, preview API and Hue test lease;
// only `invoke` answers.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import {
  LED_TEST_STATUS,
  PREVIEW_COMMANDS,
  type LedPreviewStatus,
  type StartLedTestPatternPayload,
} from "@/shared/contracts/preview";
import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";
import { __resetHueTestLease } from "@/features/hue/state/hueTestLease";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/ui/HsvColorPicker", () => ({
  HsvColorPicker: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="hsv-picker" aria-label={ariaLabel} />
  ),
}));

let storeState: Record<string, unknown> = {};

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(storeState),
    save: () => Promise.resolve(),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onMoved: () => Promise.resolve(() => {}),
    scaleFactor: () => Promise.resolve(1),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    innerSize: () => Promise.resolve({ width: 320, height: 460 }),
  }),
}));

let syncState: {
  mode: { kind: string } | null;
  active: boolean;
  preview: LedPreviewStatus | null;
};

vi.mock("../state/useLightingModeSync", () => ({
  useLightingModeSync: () => syncState,
}));

/** Whether the backend would find a strip — decides STARTED vs PREVIEW_ONLY. */
let stripConnected = true;
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { ControlPopupApp } = await import("../ui/ControlPopupApp");

function previewStatus(overrides: Partial<LedPreviewStatus> = {}): LedPreviewStatus {
  return {
    testActive: false,
    source: "idle",
    twinDisplays: [],
    popupVisible: true,
    liveTwinSupported: true,
    ...overrides,
  };
}

/** Mirrors `start_led_test_pattern`'s target resolution for a stream that is up. */
function answerStart(payload: StartLedTestPatternPayload) {
  const requested = payload.targets ?? [];
  const useUsb = stripConnected && (requested.length === 0 || requested.includes("usb"));
  const useHue = requested.includes("hue");
  const previewOnly = !useUsb && !useHue;
  return {
    active: true,
    previewOnly,
    status: {
      code: previewOnly ? LED_TEST_STATUS.PATTERN_PREVIEW_ONLY : LED_TEST_STATUS.PATTERN_STARTED,
      message: "",
      details: null,
    },
  };
}

function testStarts(): StartLedTestPatternPayload[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === PREVIEW_COMMANDS.START_TEST_PATTERN)
    .map(([, args]) => (args as { payload: StartLedTestPatternPayload }).payload);
}

function hueStreamStarts() {
  return invokeMock.mock.calls.filter(([command]) => command === HUE_COMMANDS.START_STREAM);
}

beforeEach(() => {
  __resetHueTestLease();
  stripConnected = true;
  // A paired bridge with an area: the lease would open a stream for any run
  // that asks for Hue, so a missing `start_hue_stream` proves nobody asked.
  storeState = {
    lastLedTestPattern: { kind: "gamut" },
    lastOutputTargets: ["hue"],
    lastHueBridge: { ip: "192.168.1.20" },
    hueAppKey: "app-key",
    hueClientKey: "client-key",
    lastHueAreaId: "area-1",
  };
  syncState = { mode: { kind: LIGHTING_MODE_KIND.OFF }, active: false, preview: previewStatus() };
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === PREVIEW_COMMANDS.START_TEST_PATTERN) {
      return Promise.resolve(answerStart((args as { payload: StartLedTestPatternPayload }).payload));
    }
    if (command === HUE_COMMANDS.START_STREAM) {
      return Promise.resolve({
        active: true,
        status: { state: "Running", code: HUE_RUNTIME_STATUS.STREAM_RUNNING, message: "" },
      });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ControlPopupApp auto-start targets", () => {
  it("sends the auto-start to the strip only when Hue is the saved output", async () => {
    render(<ControlPopupApp />);

    await waitFor(() => expect(testStarts()).toHaveLength(1));
    expect(testStarts()[0].targets).toEqual(["usb"]);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("preview:control.autoStart.stripOnly"),
    );
    expect(hueStreamStarts()).toHaveLength(0);
  });

  it("leaves Hue out even when it is saved alongside the strip", async () => {
    storeState = { ...storeState, lastOutputTargets: ["usb", "hue"] };
    render(<ControlPopupApp />);

    await waitFor(() => expect(testStarts()).toHaveLength(1));
    expect(testStarts()[0].targets).toEqual(["usb"]);
    expect(hueStreamStarts()).toHaveLength(0);
  });

  it("runs preview-only with no strip, without driving Hue or claiming no device", async () => {
    stripConnected = false;
    render(<ControlPopupApp />);

    await waitFor(() => expect(testStarts()).toHaveLength(1));
    expect(testStarts()[0].targets).toEqual(["usb"]);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("preview:control.autoStart.noStrip"),
    );
    // The generic copy says no device is connected, which a paired bridge makes untrue.
    expect(
      screen.queryByText("preview:status.LED_TEST_PATTERN_PREVIEW_ONLY"),
    ).not.toBeInTheDocument();
    expect(hueStreamStarts()).toHaveLength(0);
  });

  it("keeps the strip-only targets when the running auto-start is retuned", async () => {
    const user = userEvent.setup();
    // Gamut is static and disables the speed control; chase animates.
    storeState = { ...storeState, lastLedTestPattern: { kind: "chase", r: 255, g: 0, b: 0 } };
    render(<ControlPopupApp />);
    await waitFor(() => expect(testStarts()).toHaveLength(1));

    await user.click(screen.getByRole("radio", { name: "preview:test.speed.fast" }));

    await waitFor(() => expect(testStarts()).toHaveLength(2));
    expect(testStarts()[1]).toMatchObject({ speed: "fast", targets: ["usb"] });
    expect(hueStreamStarts()).toHaveLength(0);
  });

  it("stays strip-only on a re-reveal of the kept-alive popup", async () => {
    const { rerender } = render(<ControlPopupApp />);
    await waitFor(() => expect(testStarts()).toHaveLength(1));

    syncState = { ...syncState, preview: previewStatus({ popupVisible: false }) };
    rerender(<ControlPopupApp />);
    syncState = { ...syncState, preview: previewStatus({ popupVisible: true }) };
    await act(async () => {
      rerender(<ControlPopupApp />);
    });

    await waitFor(() => expect(testStarts()).toHaveLength(2));
    expect(testStarts()[1].targets).toEqual(["usb"]);
    expect(hueStreamStarts()).toHaveLength(0);
  });
});

describe("ControlPopupApp explicit pattern choice", () => {
  it("reaches the saved Hue output when the user picks a pattern", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(testStarts()).toHaveLength(1));

    await user.click(screen.getByRole("radio", { name: /preview:pattern\.rainbow/ }));

    await waitFor(() => expect(testStarts()).toHaveLength(2));
    expect(testStarts()[1]).toMatchObject({ pattern: { kind: "rainbow" }, targets: ["hue"] });
    // The lease opens the stream before the pattern is sent to it.
    expect(hueStreamStarts()).toHaveLength(1);
    const order = invokeMock.mock.calls.map(([command]) => command);
    expect(order.indexOf(HUE_COMMANDS.START_STREAM)).toBeLessThan(
      order.lastIndexOf(PREVIEW_COMMANDS.START_TEST_PATTERN),
    );
    await waitFor(() =>
      expect(screen.queryByText(/preview:control\.autoStart\./)).not.toBeInTheDocument(),
    );
  });
});
