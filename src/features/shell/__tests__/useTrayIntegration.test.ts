import { renderHook, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrayLabels } from "@/shared/contracts/shell";

import { trayStatusLabel, useTrayIntegration } from "../useTrayIntegration";

const updateTrayLabelsMock = vi.fn<(labels: TrayLabels) => Promise<void>>();

type Listener = () => void;
let previewListener: Listener | undefined;
const unlisten = vi.fn();
const listenTrayShowLedPreview = vi.fn((cb: Listener) => {
  previewListener = cb;
  return Promise.resolve(unlisten);
});

// Only the preview item is a window event. The mode items (off, Ambilight,
// solid) run the transaction in Rust, so no window listens for them.
vi.mock("@/features/tray/trayController", () => ({
  listenTrayShowLedPreview: (cb: Listener) => listenTrayShowLedPreview(cb),
}));

vi.mock("@/features/tray/trayApi", () => ({
  updateTrayLabels: (labels: TrayLabels) => updateTrayLabelsMock(labels),
}));

const keyT = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join("|")})` : key) as unknown as TFunction;

vi.mock("../windowLifecycle", () => ({
  loadShellState: () => Promise.resolve({}),
  saveShellState: () => Promise.resolve(),
}));

vi.mock("@/features/preview/previewApi", () => ({
  openLedControlPopup: () => Promise.resolve(),
  showLedControlPopup: () => Promise.resolve(),
  openLedTwinOverlay: () => Promise.resolve(),
}));

describe("useTrayIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTrayLabelsMock.mockResolvedValue(undefined);
    previewListener = undefined;
  });

  it("listens for the preview item and nothing else", async () => {
    renderHook(() => useTrayIntegration({}));

    await waitFor(() => expect(previewListener).toBeDefined());
    expect(listenTrayShowLedPreview).toHaveBeenCalledOnce();
  });

  // The line used to read a hardcoded, untranslated "● Idle" whatever ran.
  it("pushes the status line again whenever the mode or its outputs change", async () => {
    const view = renderHook((props: Parameters<typeof useTrayIntegration>[0]) => useTrayIntegration(props), {
      initialProps: { status: { mode: "off", outputs: [] } },
    });
    await waitFor(() => expect(updateTrayLabelsMock).toHaveBeenCalledTimes(1));

    view.rerender({ status: { mode: "off", outputs: [] } });
    expect(updateTrayLabelsMock).toHaveBeenCalledTimes(1);

    view.rerender({ status: { mode: "ambilight", outputs: ["usb", "hue"] } });
    await waitFor(() => expect(updateTrayLabelsMock).toHaveBeenCalledTimes(2));
    expect(Object.keys(updateTrayLabelsMock.mock.calls[1][0])).toContain("status");
  });

  // The tray greys what the window's mode buttons grey, so a tray press can
  // never reach a mode the window would not have offered.
  it("pushes the window's mode locks with the labels, and again when they change", async () => {
    const view = renderHook((props: Parameters<typeof useTrayIntegration>[0]) => useTrayIntegration(props), {
      initialProps: {
        status: { mode: "off", outputs: [] },
        lockedModes: ["ambilight", "solid"],
      } as Parameters<typeof useTrayIntegration>[0],
    });
    await waitFor(() => expect(updateTrayLabelsMock).toHaveBeenCalledTimes(1));
    const first = updateTrayLabelsMock.mock.calls[0][0];
    expect(first.lockedModes).toEqual(["ambilight", "solid"]);
    expect(Object.keys(first)).toEqual(expect.arrayContaining(["lightsOff", "ambilight", "solidColor"]));

    view.rerender({ status: { mode: "off", outputs: [] }, lockedModes: [] });
    await waitFor(() => expect(updateTrayLabelsMock).toHaveBeenCalledTimes(2));
    expect(updateTrayLabelsMock.mock.calls[1][0].lockedModes).toEqual([]);
  });

  it("logs a push the tray refused instead of leaving it unhandled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    updateTrayLabelsMock.mockRejectedValue(new Error("tray gone"));
    renderHook(() => useTrayIntegration({ status: { mode: "solid", outputs: ["wled"] } }));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error)),
    );
    consoleError.mockRestore();
  });

  it("removes its listener on unmount", async () => {
    const view = renderHook(() => useTrayIntegration({}));
    await waitFor(() => expect(previewListener).toBeDefined());

    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("trayStatusLabel", () => {
  it("says the lights are off when they are", () => {
    expect(trayStatusLabel({ mode: "off", outputs: ["usb"] }, keyT)).toBe("tray:status.off");
  });

  it("names the running mode and every output it reaches, WLED as WLED", () => {
    expect(trayStatusLabel({ mode: "ambilight", outputs: ["wled", "hue"] }, keyT)).toBe(
      "tray:status.running(common:mode.options.ambilight|common:hotplug.wledLabel + common:hotplug.targetLabel.hue)",
    );
  });

  it("names the mode alone when nothing is reached", () => {
    expect(trayStatusLabel({ mode: "solid", outputs: [] }, keyT)).toBe(
      "tray:status.runningNoOutputs(common:mode.options.solid)",
    );
  });
});
