// ControlPopupApp — "no Run press needed" contract: auto-start on reveal, every
// selection applies immediately, and the footer is the only run control.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LED_TEST_STATUS, type LedPreviewStatus } from "@/shared/contracts/preview";
import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";

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

const applyOutputs = vi.fn();
const retuneLighting = vi.fn();
// The runner borrows Hue around every run; Rust owns the lease.
const acquireHueForTest = vi.fn();
const releaseHueAfterTest = vi.fn();

vi.mock("@/features/mode/modeApi", () => ({
  applyOutputs: (...args: unknown[]) => applyOutputs(...args),
  retuneLighting: (...args: unknown[]) => retuneLighting(...args),
  acquireHueForTest: (...args: unknown[]) => acquireHueForTest(...args),
  releaseHueAfterTest: (...args: unknown[]) => releaseHueAfterTest(...args),
}));

/** What `apply_outputs` answers; the code is all the popup reads besides the snapshot. */
function outputsReply(code = "OUTPUTS_APPLIED") {
  return {
    status: { code, message: "", details: null },
    requestId: 1,
    snapshot: { revision: 1 },
    outcome: {},
  };
}

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
const adopt = vi.fn();

// The runtime snapshot every window holds, and the preview status beside it.
vi.mock("@/features/mode/state/useLightingRuntime", () => ({
  useLightingRuntime: () => ({
    snapshot: syncState.mode ? { revision: 1, mode: syncState.mode } : null,
    adopt,
  }),
}));

vi.mock("../state/usePreviewStatusSync", () => ({
  usePreviewStatusSync: () => syncState.preview,
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
  applyOutputs.mockResolvedValue(outputsReply());
  retuneLighting.mockResolvedValue({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
  acquireHueForTest.mockResolvedValue(undefined);
  releaseHueAfterTest.mockResolvedValue(undefined);
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
    await user.click(screen.getByRole("radio", { name: /common:mode\.options\.ambilight/ }));
    await waitFor(() => expect(applyOutputs).toHaveBeenCalledTimes(1));

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

    await user.click(screen.getByRole("radio", { name: /common:mode\.options\.ambilight/ }));

    await waitFor(() => expect(applyOutputs).toHaveBeenCalledTimes(1));
    expect(startLedTestPattern).not.toHaveBeenCalled();
  });
});

/**
 * The mode strip is a lighting choice like the main window's. It used to call
 * the mode commands directly, which left Hue up on Off, never started Hue for
 * Solid or Ambilight, never saved the choice, and skipped the calibration gate.
 * Rust now owns all four; the popup only has to send the choice as a choice.
 */
describe("ControlPopupApp mode strip", () => {
  async function clickMode(name: RegExp) {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name }));
    await waitFor(() => expect(applyOutputs).toHaveBeenCalledTimes(1));
    return applyOutputs.mock.calls[0][0] as { mode: Record<string, unknown>; origin: string };
  }

  it("sends Off to the transaction, which stops Hue as well as the strip", async () => {
    const request = await clickMode(/common:mode\.options\.off/);

    expect(request).toEqual({ mode: { kind: LIGHTING_MODE_KIND.OFF }, origin: "popup" });
  });

  // Rust stamps the saved outputs, display, room geometry and output settings,
  // and keeps the last Ambilight settings: a copy here would go stale, since
  // the webview outlives every hide.
  it("sends Ambilight as its kind alone, on the saved outputs Rust reads", async () => {
    const request = await clickMode(/common:mode\.options\.ambilight/);

    expect(request).toEqual({ mode: { kind: LIGHTING_MODE_KIND.AMBILIGHT }, origin: "popup" });
  });

  it("sends Solid with the colour on screen", async () => {
    syncState.mode = { kind: LIGHTING_MODE_KIND.OFF, solid: { r: 1, g: 2, b: 3, brightness: 0.4 } };
    const request = await clickMode(/common:mode\.options\.solid/);

    expect(request.origin).toBe("popup");
    expect(request.mode).toEqual({
      kind: LIGHTING_MODE_KIND.SOLID,
      solid: { r: 1, g: 2, b: 3, brightness: 0.4 },
    });
  });

  it("takes the snapshot the transaction answered with", async () => {
    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() => expect(adopt).toHaveBeenCalledWith({ revision: 1 }));
  });

  it("says a strip needs calibrating when the transaction refuses for it", async () => {
    applyOutputs.mockResolvedValue(outputsReply("OUTPUTS_CALIBRATION_REQUIRED"));

    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("preview:control.calibrationRequired"),
    );
  });
});

/**
 * A colour drag in a running Solid is a retune, never a restart: at most one
 * `retune_lighting` in flight, the newest value next, and no `apply_outputs`.
 */
describe("ControlPopupApp Solid drag", () => {
  it("coalesces a burst of brightness commits into the first and the last", async () => {
    syncState = {
      ...syncState,
      mode: { kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 10, g: 20, b: 30, brightness: 1 } },
    };
    let answer!: () => void;
    retuneLighting.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
        }),
    );
    render(<ControlPopupApp />);
    await waitFor(() => expect(startLedTestPattern).toHaveBeenCalled());
    // Hand the light to the mode, which disengages the test.
    fireEvent.click(screen.getByRole("radio", { name: /common:mode\.options\.solid/ }));
    await waitFor(() => expect(applyOutputs).toHaveBeenCalledTimes(1));
    applyOutputs.mockClear();

    const slider = screen.getByRole("slider", { name: "common:mode.brightness" });
    for (const value of [90, 80, 70, 60, 50, 40, 30, 20]) {
      fireEvent.change(slider, { target: { value: String(value) } });
      // Past the 50 ms commit floor of the colour draft, so every move commits.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
    }

    expect(retuneLighting).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer();
    });
    await waitFor(() => expect(retuneLighting).toHaveBeenCalledTimes(2));
    expect(retuneLighting.mock.calls[1][0]).toEqual({
      solid: { r: 10, g: 20, b: 30, brightness: 0.2 },
    });
    expect(applyOutputs).not.toHaveBeenCalled();
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
