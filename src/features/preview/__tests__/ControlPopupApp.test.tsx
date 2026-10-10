// ControlPopupApp — the preview session's remote: opening it changes no light,
// the mode strip runs the lighting transaction, Close ends the session and Hide
// keeps it open.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_STATUS, type PreviewSessionResult, type PreviewStatusCode } from "@/shared/contracts/preview";
import type { LightingOutputsStatusCode } from "@/shared/contracts/lightingRuntime";
import { outputsResult, runtimeSnapshot } from "@/test/lightingRuntime";
import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";
import type * as previewApiModule from "../previewApi";
import type * as modeApiModule from "@/features/mode/modeApi";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/ui/HsvColorPicker/HsvColorPicker", () => ({
  HsvColorPicker: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="hsv-picker" aria-label={ariaLabel} />
  ),
}));

const closePreview = vi.fn<typeof previewApiModule.closePreview>();
const setPreviewPopupHidden = vi.fn<typeof previewApiModule.setPreviewPopupHidden>();

vi.mock("../previewApi", () => ({
  closePreview: (...args: Parameters<typeof closePreview>) => closePreview(...args),
  setPreviewPopupHidden: (...args: Parameters<typeof setPreviewPopupHidden>) => setPreviewPopupHidden(...args),
}));

const applyOutputs = vi.fn<typeof modeApiModule.applyOutputs>();
const retuneLighting = vi.fn<typeof modeApiModule.retuneLighting>();

vi.mock("@/features/mode/modeApi", () => ({
  applyOutputs: (...args: Parameters<typeof applyOutputs>) => applyOutputs(...args),
  retuneLighting: (...args: Parameters<typeof retuneLighting>) => retuneLighting(...args),
}));

/** What `apply_outputs` answers; the code is all the popup reads besides the snapshot. */
function outputsReply(code: LightingOutputsStatusCode = "OUTPUTS_APPLIED") {
  return outputsResult(code, runtimeSnapshot());
}

const storeSave = vi.fn();
let storeState: Record<string, unknown> = {};

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(storeState),
    save: (...args: Parameters<typeof storeSave>) => storeSave(...args),
  },
}));

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: Parameters<typeof invokeMock>) => invokeMock(...args),
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
  mode: { kind: string; solid?: { r: number; g: number; b: number; brightness: number; kelvin?: number } } | null;
};
const adopt = vi.fn();

vi.mock("@/features/mode/state/useLightingRuntime", () => ({
  useLightingRuntime: () => ({
    snapshot: syncState.mode ? { revision: 1, mode: syncState.mode } : null,
    adopt,
  }),
}));

const { ControlPopupApp } = await import("../ui/ControlPopupApp");

function sessionReply(code: PreviewStatusCode): PreviewSessionResult {
  return { session: { state: "closed" }, status: { code, message: "", details: null } };
}

beforeEach(() => {
  movedHandler = null;
  storeState = { lastOutputTargets: ["usb"] };
  storeSave.mockResolvedValue(undefined);
  closePreview.mockResolvedValue(sessionReply(PREVIEW_STATUS.CLOSED));
  setPreviewPopupHidden.mockResolvedValue(sessionReply(PREVIEW_STATUS.POPUP_UPDATED));
  applyOutputs.mockResolvedValue(outputsReply());
  retuneLighting.mockResolvedValue({ status: { code: "RETUNE_APPLIED", message: "", details: null } });
  invokeMock.mockResolvedValue(undefined);
  syncState = { mode: { kind: LIGHTING_MODE_KIND.OFF } };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ControlPopupApp opening", () => {
  it("changes no light by opening", async () => {
    render(<ControlPopupApp />);
    await screen.findByRole("radio", { name: /common:mode\.options\.off/ });

    expect(applyOutputs).not.toHaveBeenCalled();
    expect(retuneLighting).not.toHaveBeenCalled();
  });
});

describe("ControlPopupApp close and hide", () => {
  it("Close ends the session", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);

    await user.click(screen.getByRole("button", { name: "preview:control.close" }));

    expect(closePreview).toHaveBeenCalledTimes(1);
    expect(applyOutputs).not.toHaveBeenCalled();
  });

  it("Escape ends the session as Close does", async () => {
    render(<ControlPopupApp />);

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(closePreview).toHaveBeenCalledTimes(1));
  });

  it("Hide keeps the session and asks only for the popup to go", async () => {
    const user = userEvent.setup();
    render(<ControlPopupApp />);

    await user.click(screen.getByRole("button", { name: "preview:control.hide" }));

    expect(setPreviewPopupHidden).toHaveBeenCalledWith(true);
    expect(closePreview).not.toHaveBeenCalled();
  });

  // A twin that outlives its close is click-through and undecorated: say so.
  it("says a window survived the close", async () => {
    closePreview.mockResolvedValue(sessionReply(PREVIEW_STATUS.CLOSE_FAILED));
    const user = userEvent.setup();
    render(<ControlPopupApp />);

    await user.click(screen.getByRole("button", { name: "preview:control.close" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("preview:status.PREVIEW_CLOSE_FAILED");
  });
});

describe("ControlPopupApp mode strip", () => {
  async function clickMode(name: RegExp) {
    const user = userEvent.setup();
    render(<ControlPopupApp />);
    await user.click(screen.getByRole("radio", { name }));
    await waitFor(() => expect(applyOutputs).toHaveBeenCalledTimes(1));
    return applyOutputs.mock.calls[0][0];
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

  // A White solid switched back on from the popup stays White, not a colour of the same RGB.
  it("sends a White solid with its temperature", async () => {
    syncState.mode = {
      kind: LIGHTING_MODE_KIND.OFF,
      solid: { r: 255, g: 206, b: 166, brightness: 0.4, kelvin: 4000 },
    };
    const request = await clickMode(/common:mode\.options\.solid/);

    expect(request.mode).toEqual({
      kind: LIGHTING_MODE_KIND.SOLID,
      solid: { r: 255, g: 206, b: 166, brightness: 0.4, kelvin: 4000 },
    });
  });

  it("takes the snapshot the transaction answered with", async () => {
    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() => expect(adopt).toHaveBeenCalledWith(runtimeSnapshot()));
  });

  it("says a strip needs calibrating when the transaction refuses for it", async () => {
    applyOutputs.mockResolvedValue(outputsReply("OUTPUTS_CALIBRATION_REQUIRED"));

    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("preview:control.calibrationRequired"),
    );
  });

  // A refused or failed choice used to reach a console line and nothing else.
  it("says why a choice did not start, in the main window's words", async () => {
    applyOutputs.mockResolvedValue(
      outputsResult("OUTPUTS_START_FAILED", runtimeSnapshot(), {
        applyStatus: {
          code: "AMBILIGHT_MODE_START_FAILED",
          message: "",
          details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
        },
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("shell:notices.messages.capturePermission"),
    );
  });

  it("says a refused choice changed nothing when no reason is named", async () => {
    applyOutputs.mockResolvedValue(outputsReply("OUTPUTS_REFUSED"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await clickMode(/common:mode\.options\.solid/);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("shell:notices.messages.choiceRefused"),
    );
  });

  it("raises nothing for a choice that runs", async () => {
    applyOutputs.mockResolvedValue(
      outputsResult("OUTPUTS_APPLIED_PARTIAL", runtimeSnapshot(), { hueLeftOut: "unreachable" }),
    );

    await clickMode(/common:mode\.options\.ambilight/);

    await waitFor(() => expect(adopt).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
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
