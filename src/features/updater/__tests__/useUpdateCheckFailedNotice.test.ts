// The startup check usually fails with the window in the tray, where WebView2
// still reports the document "visible": the countdown must follow Rust.

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

import { UPDATE_CHECK_FAILED_NOTICE_MS, useUpdateCheckFailedNotice } from "../useUpdateCheckFailedNotice";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("useUpdateCheckFailedNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    getMainWindowVisibilityMock.mockReset().mockResolvedValue({ visible: false });
    pushWindowVisibility = null;
  });
  afterEach(() => {
    __resetWindowVisibilityForTests();
    vi.useRealTimers();
  });

  it("keeps the notice while the window sits in the tray, and counts down once it is shown", async () => {
    const stop = subscribeWindowVisible(() => {});
    await flush();

    const { result } = renderHook(() => useUpdateCheckFailedNotice());
    act(() => result.current.report({ message: "offline" }));
    await flush();

    act(() => {
      vi.advanceTimersByTime(UPDATE_CHECK_FAILED_NOTICE_MS * 3);
    });
    expect(result.current.notice).not.toBeNull();

    act(() => pushWindowVisibility?.({ visible: true }));
    act(() => {
      vi.advanceTimersByTime(UPDATE_CHECK_FAILED_NOTICE_MS);
    });
    expect(result.current.notice).toBeNull();
    stop();
  });
});
