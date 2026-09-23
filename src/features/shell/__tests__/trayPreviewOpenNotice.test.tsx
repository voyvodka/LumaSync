// The tray's "Show LED Preview" through the real tray hook, the real notice
// hook and the real toast stack; only the Tauri-facing modules are faked.
// A refused open used to leave the user with nothing at all.

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/features/mode/model/contracts";
import {
  PREVIEW_OPEN_NOTICE_MS,
  usePreviewOpenNotice,
} from "@/features/preview/state/usePreviewOpenNotice";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { ShellNotices } from "../ShellNotices";
import { useTrayIntegration } from "../useTrayIntegration";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let showPreview: (() => void) | null = null;
vi.mock("@/features/tray/trayController", () => ({
  listenTrayLightsOff: () => Promise.resolve(() => {}),
  listenTrayResumeLastMode: () => Promise.resolve(() => {}),
  listenTraySolidColor: () => Promise.resolve(() => {}),
  listenTrayShowLedPreview: (cb: () => void) => {
    showPreview = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/features/tray/trayApi", () => ({
  updateTrayLabels: () => Promise.resolve(),
}));

const saveShellStateMock = vi.fn();
let twinEnabled = false;
vi.mock("../windowLifecycle", () => ({
  loadShellState: () => Promise.resolve({ ledTwinEnabledTest: twinEnabled }),
  saveShellState: (partial: unknown) => saveShellStateMock(partial),
}));

const openOverlayMock = vi.fn();
const openPopupMock = vi.fn();
const showPopupMock = vi.fn();
vi.mock("@/features/preview/previewApi", () => ({
  openLedTwinOverlay: (...args: unknown[]) => openOverlayMock(...args),
  openLedControlPopup: () => openPopupMock(),
  showLedControlPopup: () => showPopupMock(),
}));

const POPUP_OK = { ok: true, code: "CONTROL_POPUP_SHOWN", message: "", visible: true };

function Harness() {
  const preview = usePreviewOpenNotice();
  useTrayIntegration({
    onLightingModeChange: async () => {},
    lightingModeRef: { current: { kind: LIGHTING_MODE_KIND.OFF } as LightingModeConfig },
    lastNonOffModeRef: { current: null },
    selectedOutputTargetsRef: { current: [] as HueRuntimeTarget[] },
    getSelectedDisplayId: () => "display-2",
    onPreviewOpenFailed: preview.report,
  });
  return (
    <ShellNotices
      usbDisconnected={false}
      usbUnsupported={false}
      stopFailedTargets={null}
      startFailure={null}
      hueLeftOut={null}
      captureStalled={null}
      hueColorNotice={null}
      previewOpenFailure={preview.notice}
      onOpenCaptureSettings={() => {}}
    />
  );
}

async function clickTrayShowPreview() {
  render(<Harness />);
  await waitFor(() => expect(showPreview).not.toBeNull());
  await act(async () => {
    showPreview?.();
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("tray Show LED Preview — a refused open is reported", () => {
  beforeEach(() => {
    showPreview = null;
    twinEnabled = false;
    setVisibility("visible");
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveShellStateMock.mockReset().mockResolvedValue(undefined);
    openOverlayMock.mockReset().mockResolvedValue({ ok: true, code: "TWIN_OVERLAY_OPENED", message: "" });
    openPopupMock.mockReset().mockResolvedValue(POPUP_OK);
    showPopupMock.mockReset().mockResolvedValue(POPUP_OK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises a toast when the control popup cannot open", async () => {
    openPopupMock.mockResolvedValue({ ok: false, code: "CONTROL_POPUP_FAILED", message: "webview", visible: false });

    await clickTrayShowPreview();

    expect(await screen.findByTestId("preview-open-failed-notice")).toHaveTextContent(
      "preview:status.CONTROL_POPUP_FAILED",
    );
    expect(saveShellStateMock).not.toHaveBeenCalledWith({ ledPreviewPopupVisible: true });
  });

  it("raises a toast when the twin overlay's display is gone", async () => {
    twinEnabled = true;
    openOverlayMock.mockResolvedValue({ ok: false, code: "TWIN_OVERLAY_DISPLAY_NOT_FOUND", message: "gone" });

    await clickTrayShowPreview();

    expect(await screen.findByTestId("preview-open-failed-notice")).toHaveTextContent(
      "preview:status.TWIN_OVERLAY_DISPLAY_NOT_FOUND",
    );
    expect(openOverlayMock).toHaveBeenCalledWith({ scope: "test", displayId: "display-2" });
  });

  it("stays silent when everything opened", async () => {
    twinEnabled = true;

    await clickTrayShowPreview();

    await waitFor(() => expect(openOverlayMock).toHaveBeenCalled());
    expect(saveShellStateMock).toHaveBeenCalledWith({ ledPreviewPopupVisible: true });
    expect(screen.queryByTestId("preview-open-failed-notice")).toBeNull();
  });

  it("holds the toast while the main window is hidden, then lets it expire", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibility("hidden");
    openPopupMock.mockResolvedValue({ ok: false, code: "CONTROL_POPUP_FAILED", message: "webview", visible: false });

    await clickTrayShowPreview();
    await screen.findByTestId("preview-open-failed-notice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_OPEN_NOTICE_MS * 3);
    });
    expect(screen.getByTestId("preview-open-failed-notice")).toBeInTheDocument();

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(PREVIEW_OPEN_NOTICE_MS);
    });
    expect(screen.queryByTestId("preview-open-failed-notice")).toBeNull();
  });
});
