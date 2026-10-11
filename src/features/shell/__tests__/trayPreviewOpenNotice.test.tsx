// The tray's "Show LED Preview" through the real tray hook, the real notice
// hook and the real notice queue and slot; only the Tauri-facing modules are
// faked. A refused open used to leave the user with nothing at all.

import { act, render, screen, waitFor } from "@testing-library/react";
import { PREVIEW_STATUS, type PreviewSessionResult, type PreviewSessionStatusCode } from "@/shared/contracts/preview";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREVIEW_OPEN_NOTICE_MS,
  usePreviewOpenNotice,
} from "@/features/preview/state/usePreviewOpenNotice";

import { buildShellNotices } from "../notices/buildShellNotices";
import { ShellNoticeSlot } from "../notices/ShellNoticeSlot";
import { useShellNoticeQueue } from "../notices/useShellNoticeQueue";
import { keyT, makeHandlers, QUIET_INPUT } from "../notices/__tests__/noticeFixtures";
import { useTrayIntegration } from "../useTrayIntegration";
import type * as previewApiModule from "@/features/preview/previewApi";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let showPreview: (() => void) | null = null;
vi.mock("@/features/tray/trayController", () => ({
  listenTrayShowLedPreview: (cb: () => void) => {
    showPreview = cb;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/features/tray/trayApi", () => ({
  updateTrayLabels: () => Promise.resolve(),
}));

const openPreviewMock = vi.fn<typeof previewApiModule.openPreview>();
vi.mock("@/features/preview/previewApi", () => ({
  openPreview: () => openPreviewMock(),
}));

function opened(code: PreviewSessionStatusCode): PreviewSessionResult {
  const failed = code !== PREVIEW_STATUS.OPENED && code !== PREVIEW_STATUS.ALREADY_OPEN;
  return {
    session: failed ? { state: "closed" } : { state: "live", displayId: "display-2", popupHidden: false, twinHidden: false, twinHeldForCapture: false },
    status: { code, message: "", details: failed ? "webview" : null },
  };
}

function Harness() {
  const preview = usePreviewOpenNotice();
  useTrayIntegration({ onPreviewOpenFailed: preview.report });
  const candidates = useMemo(
    () => buildShellNotices({ ...QUIET_INPUT, uiMode: "full", previewOpenFailure: preview.notice }, handlers, keyT),
    [preview.notice],
  );
  const queue = useShellNoticeQueue(candidates, { suppressed: false });
  return <ShellNoticeSlot variant="full" queue={queue} suppressed={false} />;
}

const handlers = makeHandlers();

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
    setVisibility("visible");
    vi.spyOn(console, "error").mockImplementation(() => {});
    openPreviewMock.mockReset().mockResolvedValue(opened(PREVIEW_STATUS.OPENED));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises a toast when a preview window cannot open", async () => {
    openPreviewMock.mockResolvedValue(opened(PREVIEW_STATUS.OPEN_FAILED));

    await clickTrayShowPreview();

    expect(await screen.findByTestId("preview-open-failed-notice")).toHaveTextContent(
      "shell:notices.messages.previewOpenFailed.failed",
    );
  });

  it.each([PREVIEW_STATUS.OPENED, PREVIEW_STATUS.ALREADY_OPEN])("stays silent on %s", async (code) => {
    openPreviewMock.mockResolvedValue(opened(code));

    await clickTrayShowPreview();

    await waitFor(() => expect(openPreviewMock).toHaveBeenCalled());
    expect(screen.queryByTestId("preview-open-failed-notice")).toBeNull();
  });

  it("holds the toast while the main window is hidden, then lets it expire", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibility("hidden");
    openPreviewMock.mockResolvedValue(opened(PREVIEW_STATUS.OPEN_FAILED));

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
    // The strip closes with it inside; its Reveal lets it go 400 ms later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(screen.queryByTestId("preview-open-failed-notice")).toBeNull();
  });
});
