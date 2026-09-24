// WebView2 keeps `document.visibilityState` at "visible" with the window in
// the tray, so a countdown keyed on the document ran out unseen.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MainWindowVisibility } from "@/shared/contracts/shell";

const getMainWindowVisibilityMock = vi.fn<() => Promise<MainWindowVisibility>>();
let pushWindowVisibility: ((visibility: MainWindowVisibility) => void) | null = null;

vi.mock("@/features/shell/windowVisibilityApi", () => ({
  getMainWindowVisibility: () => getMainWindowVisibilityMock(),
}));
vi.mock("@/features/shell/windowVisibilityEventsApi", () => ({
  listenMainWindowVisibility: (handler: (visibility: MainWindowVisibility) => void) => {
    pushWindowVisibility = handler;
    return Promise.resolve(() => {});
  },
}));

import { __resetWindowVisibilityForTests, subscribeWindowVisible } from "@/features/shell/windowVisibility";

import { PREVIEW_OPEN_NOTICE_MS, usePreviewOpenNotice } from "../usePreviewOpenNotice";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("usePreviewOpenNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    getMainWindowVisibilityMock.mockReset().mockResolvedValue({ visible: true });
    pushWindowVisibility = null;
  });
  afterEach(() => {
    __resetWindowVisibilityForTests();
    vi.useRealTimers();
  });

  it("does not run out while Rust says the window is hidden, whatever the document says", async () => {
    getMainWindowVisibilityMock.mockResolvedValue({ visible: false });
    // The shell's own subscription, which has already heard Rust's answer.
    const stop = subscribeWindowVisible(() => {});
    await flush();

    const { result } = renderHook(() => usePreviewOpenNotice());
    act(() => result.current.report("CONTROL_POPUP_FAILED"));
    await flush();

    act(() => {
      vi.advanceTimersByTime(PREVIEW_OPEN_NOTICE_MS * 3);
    });
    expect(result.current.notice).toBe("CONTROL_POPUP_FAILED");

    // Shown again: now it gets its full time, and then goes.
    act(() => pushWindowVisibility?.({ visible: true }));
    act(() => {
      vi.advanceTimersByTime(PREVIEW_OPEN_NOTICE_MS - 1);
    });
    expect(result.current.notice).toBe("CONTROL_POPUP_FAILED");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.notice).toBeNull();
    stop();
  });

  it("stops its countdown when the window goes to the tray mid-way", async () => {
    const { result } = renderHook(() => usePreviewOpenNotice());
    act(() => result.current.report("CONTROL_POPUP_FAILED"));
    await flush();

    act(() => {
      vi.advanceTimersByTime(PREVIEW_OPEN_NOTICE_MS - 1_000);
    });
    act(() => pushWindowVisibility?.({ visible: false }));
    act(() => {
      vi.advanceTimersByTime(PREVIEW_OPEN_NOTICE_MS * 2);
    });
    expect(result.current.notice).toBe("CONTROL_POPUP_FAILED");
  });

  it("still runs out on screen", async () => {
    const { result } = renderHook(() => usePreviewOpenNotice());
    act(() => result.current.report("CONTROL_POPUP_FAILED"));
    await flush();

    act(() => {
      vi.advanceTimersByTime(PREVIEW_OPEN_NOTICE_MS);
    });
    expect(result.current.notice).toBeNull();
  });
});
