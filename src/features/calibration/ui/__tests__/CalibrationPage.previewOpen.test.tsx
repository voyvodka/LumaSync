// "Test & Preview" on LED Setup opens the twin overlay and the control popup.
// The preview API never throws, so a refused open comes back as `ok: false`
// and used to vanish — the click did nothing and said nothing.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CalibrationPage } from "../CalibrationPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: () => Promise.resolve() }),
}));

const saveMock = vi.fn();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: unknown) => saveMock(partial),
  },
}));

vi.mock("@/features/calibration/calibrationApi", () => ({
  listDisplays: () => Promise.resolve([]),
  openDisplayOverlay: vi.fn(),
  closeDisplayOverlay: () => Promise.resolve({ ok: true }),
  updateDisplayOverlayPreview: () => Promise.resolve({ ok: true }),
}));

vi.mock("@/features/mode/modeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/mode/modeApi")>()),
  acquireHueForTest: vi.fn(),
  releaseHueAfterTest: vi.fn(),
}));

const openOverlayMock = vi.fn();
const openPopupMock = vi.fn();
const showPopupMock = vi.fn();
vi.mock("@/features/preview/previewApi", () => ({
  openLedTwinOverlay: (...args: unknown[]) => openOverlayMock(...args),
  openLedControlPopup: () => openPopupMock(),
  showLedControlPopup: () => showPopupMock(),
  startLedTestPattern: vi.fn(),
  stopLedTestPattern: () => Promise.resolve({ status: { code: "LED_TEST_PATTERN_STOPPED" } }),
}));

const OVERLAY_OK = { ok: true, code: "TWIN_OVERLAY_OPENED", message: "" };
const POPUP_OK = { ok: true, code: "CONTROL_POPUP_SHOWN", message: "", visible: true };

async function clickPreview() {
  const user = userEvent.setup();
  render(<CalibrationPage onNavigateBack={() => {}} onSaved={() => {}} />);
  await user.click(screen.getByRole("button", { name: /preview:entry\.ledSetupButton/ }));
}

describe("CalibrationPage — opening the LED preview", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveMock.mockReset().mockResolvedValue(undefined);
    openOverlayMock.mockReset().mockResolvedValue(OVERLAY_OK);
    openPopupMock.mockReset().mockResolvedValue(POPUP_OK);
    showPopupMock.mockReset().mockResolvedValue(POPUP_OK);
  });

  it("says so when the twin overlay's display is gone", async () => {
    openOverlayMock.mockResolvedValue({
      ok: false,
      code: "TWIN_OVERLAY_DISPLAY_NOT_FOUND",
      message: "no display",
    });

    await clickPreview();

    expect(await screen.findByText("preview:status.TWIN_OVERLAY_DISPLAY_NOT_FOUND")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says so when the control popup cannot open, and does not record it as visible", async () => {
    openPopupMock.mockResolvedValue({ ok: false, code: "CONTROL_POPUP_FAILED", message: "webview", visible: false });

    await clickPreview();

    expect(await screen.findByText("preview:status.CONTROL_POPUP_FAILED")).toBeInTheDocument();
    expect(showPopupMock).not.toHaveBeenCalled();
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith({ ledTwinEnabledTest: true });
  });

  it("shows nothing when both open", async () => {
    await clickPreview();

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith({ ledPreviewPopupVisible: true, ledTwinEnabledTest: true });
    expect(screen.queryByText(/^preview:status\./)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
