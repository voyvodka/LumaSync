// ControlPopupApp — "no Run press needed" contract: auto-start on reveal, every
// selection applies immediately, and the footer is the only run control.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LED_TEST_STATUS, type LedPreviewStatus } from "@/shared/contracts/preview";
import { LIGHTING_MODE_KIND } from "@/features/mode/model/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/ui/HsvColorPicker", () => ({
  HsvColorPicker: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="hsv-picker" aria-label={ariaLabel} />
  ),
}));

const startLedTestPattern = vi.fn();
const stopLedTestPattern = vi.fn();
const closeLedTwinOverlay = vi.fn();
const hideLedControlPopup = vi.fn();

vi.mock("../previewApi", () => ({
  startLedTestPattern: (...args: unknown[]) => startLedTestPattern(...args),
  stopLedTestPattern: (...args: unknown[]) => stopLedTestPattern(...args),
  closeLedTwinOverlay: (...args: unknown[]) => closeLedTwinOverlay(...args),
  hideLedControlPopup: (...args: unknown[]) => hideLedControlPopup(...args),
}));

const setLightingMode = vi.fn();
const stopLighting = vi.fn();

vi.mock("@/features/mode/modeApi", () => ({
  setLightingMode: (...args: unknown[]) => setLightingMode(...args),
  stopLighting: (...args: unknown[]) => stopLighting(...args),
}));

const storeSave = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(storeState),
    save: (...args: unknown[]) => storeSave(...args),
  },
}));

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

/** Captured `onMoved` handler so a test can simulate the user dragging the popup. */
let movedHandler: (() => void) | null = null;
const unlistenMoved = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onMoved: (handler: () => void) => {
      movedHandler = handler;
      return Promise.resolve(unlistenMoved);
    },
    // Physical 400,200 at scale 2 with a 640×920 physical inner size ⇒ a
    // logical centre of (200 + 160, 100 + 230) = (360, 330).
    scaleFactor: () => Promise.resolve(2),
    outerPosition: () => Promise.resolve({ x: 400, y: 200 }),
    innerSize: () => Promise.resolve({ width: 640, height: 920 }),
  }),
}));

let syncState: {
  mode: { kind: string; solid?: { r: number; g: number; b: number; brightness: number } } | null;
  active: boolean;
  preview: LedPreviewStatus | null;
};

vi.mock("../state/useLightingModeSync", () => ({
  useLightingModeSync: () => syncState,
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

function startResult(code: string = LED_TEST_STATUS.PATTERN_STARTED) {
  return { active: true, previewOnly: false, status: { code, message: "" } };
}

/** Latest payload handed to `start_led_test_pattern`. */
function lastStart() {
  const calls = startLedTestPattern.mock.calls;
  return calls[calls.length - 1][0] as {
    pattern: { kind: string };
    brightness: number;
    speed: string;
  };
}

beforeEach(() => {
  movedHandler = null;
  storeState = { lastLedTestPattern: { kind: "rainbow" }, lastOutputTargets: ["usb"] };
  storeSave.mockResolvedValue(undefined);
  startLedTestPattern.mockResolvedValue(startResult());
  stopLedTestPattern.mockResolvedValue({
    active: false,
    previewOnly: false,
    status: { code: LED_TEST_STATUS.PATTERN_STOPPED, message: "" },
  });
  closeLedTwinOverlay.mockResolvedValue({ ok: true });
  hideLedControlPopup.mockResolvedValue({ ok: true });
  setLightingMode.mockResolvedValue({});
  stopLighting.mockResolvedValue({});
  invokeMock.mockResolvedValue(undefined);
  syncState = {
    mode: { kind: LIGHTING_MODE_KIND.OFF },
    active: false,
    preview: previewStatus(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ControlPopupApp auto-start", () => {
  it("runs the persisted pattern on reveal without any button press", async () => {
    render(<ControlPopupApp />);

    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));
    expect(lastStart().pattern.kind).toBe("rainbow");
  });

  it("auto-starts even when the mode strip reads Off", async () => {
    syncState.mode = { kind: LIGHTING_MODE_KIND.OFF };
    render(<ControlPopupApp />);

    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));
  });

  it("does not re-fire while the popup stays visible", async () => {
    const { rerender } = render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));

    syncState = { ...syncState, preview: previewStatus({ testActive: true, source: "test" }) };
    rerender(<ControlPopupApp />);
    await waitFor(() => expect(screen.getByText("preview:status.test")).toBeInTheDocument());

    expect(startLedTestPattern).toHaveBeenCalledTimes(1);
  });

  it("does not retry in a loop when the start fails", async () => {
    startLedTestPattern.mockResolvedValue({
      active: false,
      previewOnly: false,
      status: { code: LED_TEST_STATUS.PATTERN_NO_CALIBRATION, message: "" },
    });
    render(<ControlPopupApp />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(
      `preview:status.${LED_TEST_STATUS.PATTERN_NO_CALIBRATION}`,
    );
    expect(startLedTestPattern).toHaveBeenCalledTimes(1);
  });
});

describe("ControlPopupApp immediate apply", () => {
  it("starts the pattern as soon as a tile is picked", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("radio", { name: /preview:pattern\.spiral/ }));

    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(2));
    expect(lastStart().pattern.kind).toBe("spiral");
  });

  it("applies a speed change to the running pattern with no restart press", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("radio", { name: "preview:test.speed.fast" }));

    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(2));
    expect(lastStart().speed).toBe("fast");
  });

  it("persists the pattern that started", async () => {
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(storeSave).toHaveBeenCalledWith({ lastLedTestPattern: { kind: "rainbow" } }),
    );
  });
});

describe("ControlPopupApp run controls", () => {
  // The window is undecorated, always-on-top and absent from the taskbar, so
  // Close must be reachable in EVERY state — including after a mode-strip
  // click drops `testActive`, which used to leave no exit at all.
  it("exposes Close as the only run control, in both states", async () => {
    const { rerender } = render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());

    const assertOnlyClose = () => {
      expect(screen.queryByRole("button", { name: "preview:test.run" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "preview:test.stop" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "preview:control.close" })).toBeInTheDocument();
    };

    assertOnlyClose();

    syncState = { ...syncState, preview: previewStatus({ testActive: true, source: "test" }) };
    rerender(<ControlPopupApp />);
    await waitFor(() => expect(screen.getByText("preview:status.test")).toBeInTheDocument());
    assertOnlyClose();
  });

  it("keeps starting under the pattern tiles now that Run is gone", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("radio", { name: /preview:pattern\.chase/ }));

    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalledTimes(2));
    expect(lastStart().pattern.kind).toBe("chase");
  });

  it("Close stops the test, drops the twin and clears the persisted flags", async () => {
    const user = userEvent.setup();
    syncState = { ...syncState, preview: previewStatus({ testActive: true, source: "test" }) };
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "preview:control.close" }));

    await waitFor(() => expect(stopLedTestPattern).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(closeLedTwinOverlay).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hideLedControlPopup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(storeSave).toHaveBeenCalledWith({
        ledPreviewPopupVisible: false,
        ledTwinEnabledTest: false,
      }),
    );
  });

  // `stop_led_test_pattern` restores the captured prior mode, and a mode-strip
  // click already consumed it — so stopping a test that is not running lands
  // on `LightingModeConfig::default()` (Off) and kills the user's lighting.
  it("does not touch the lighting when closing with no test engaged", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());

    // Hand the light back to a real mode, which disengages the test.
    await user.click(screen.getByRole("radio", { name: /general\.mode\.options\.ambilight/ }));
    await waitFor(() => expect(setLightingMode).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "preview:control.close" }));

    await waitFor(() => expect(hideLedControlPopup).toHaveBeenCalledTimes(1));
    expect(stopLedTestPattern).not.toHaveBeenCalled();
    // The twin still has to go — it is click-through and undismissable alone.
    expect(closeLedTwinOverlay).toHaveBeenCalledTimes(1);
  });

  it("the first close teaches how to reopen, not that it kept running", async () => {
    const user = userEvent.setup();
    storeState = { ...storeState, ledPreviewHintShown: false };
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "preview:control.close" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("show_notification", {
        payload: {
          title: "preview:title",
          body: "preview:control.reopenHint",
          kind: "info",
        },
      }),
    );
    await waitFor(() => expect(storeSave).toHaveBeenCalledWith({ ledPreviewHintShown: true }));
  });

  it("a mode-strip click takes the light back from the test", async () => {
    const user = userEvent.setup();
    syncState = { ...syncState, preview: previewStatus({ testActive: true, source: "test" }) };
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());
    startLedTestPattern.mockClear();

    await user.click(screen.getByRole("radio", { name: /general\.mode\.options\.ambilight/ }));

    await waitFor(() => expect(setLightingMode).toHaveBeenCalledTimes(1));
    expect(startLedTestPattern).not.toHaveBeenCalled();
  });
});

/** Every `shellStore.save` call that carried a persisted popup centre. */
function centreWrites() {
  return storeSave.mock.calls.filter(
    (call) => (call[0] as Record<string, unknown>)?.ledPreviewPopupCenterX !== undefined,
  );
}

describe("ControlPopupApp position persistence", () => {
  it("stores the logical centre after the popup is dragged", async () => {
    render(<ControlPopupApp />);
    await waitFor(() => expect(movedHandler).not.toBeNull());

    movedHandler?.();

    await waitFor(
      () =>
        expect(storeSave).toHaveBeenCalledWith({
          ledPreviewPopupCenterX: 360,
          ledPreviewPopupCenterY: 330,
        }),
      { timeout: 3000 },
    );
  });

  it("coalesces a burst of move events into a single write", async () => {
    render(<ControlPopupApp />);
    await waitFor(() => expect(movedHandler).not.toBeNull());

    movedHandler?.();
    movedHandler?.();
    movedHandler?.();

    await waitFor(() => expect(centreWrites()).toHaveLength(1), { timeout: 3000 });
  });
});
