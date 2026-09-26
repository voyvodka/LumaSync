import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MainWindowVisibility } from "@/shared/contracts/shell";

const getMainWindowVisibilityMock = vi.fn<() => Promise<MainWindowVisibility>>();
let pushWindowVisibility: ((visibility: MainWindowVisibility) => void) | null = null;
const unlistenMock = vi.fn<() => void>();

vi.mock("../windowVisibilityApi", () => ({
  getMainWindowVisibility: () => getMainWindowVisibilityMock(),
}));
vi.mock("../windowVisibilityEventsApi", () => ({
  listenMainWindowVisibility: (handler: (visibility: MainWindowVisibility) => void) => {
    pushWindowVisibility = handler;
    return Promise.resolve(unlistenMock);
  },
}));

import { __resetWindowVisibilityForTests, isWindowVisible, subscribeWindowVisible } from "../windowVisibility";

function setDocumentVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("windowVisibility", () => {
  beforeEach(() => {
    setDocumentVisibility("visible");
    getMainWindowVisibilityMock.mockReset().mockResolvedValue({ visible: true });
    unlistenMock.mockReset();
    pushWindowVisibility = null;
  });
  afterEach(() => {
    __resetWindowVisibilityForTests();
  });

  it("reads hidden once Rust answers hidden, while the document reads visible", async () => {
    getMainWindowVisibilityMock.mockResolvedValue({ visible: false });
    const seen = vi.fn<(visible: boolean) => void>();
    subscribeWindowVisible(seen);
    expect(isWindowVisible()).toBe(true);

    await flush();
    expect(isWindowVisible()).toBe(false);
    expect(seen).toHaveBeenLastCalledWith(false);
  });

  it("follows Rust's pushes", async () => {
    const seen = vi.fn<(visible: boolean) => void>();
    subscribeWindowVisible(seen);
    await flush();

    pushWindowVisibility?.({ visible: false });
    expect(seen).toHaveBeenLastCalledWith(false);
    pushWindowVisibility?.({ visible: true });
    expect(seen).toHaveBeenLastCalledWith(true);
  });

  it("drops a read that resolves after a newer push", async () => {
    let answer: (visibility: MainWindowVisibility) => void = () => {};
    getMainWindowVisibilityMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    subscribeWindowVisible(vi.fn<(visible: boolean) => void>());
    await flush();

    pushWindowVisibility?.({ visible: false });
    answer({ visible: true });
    await flush();
    expect(isWindowVisible()).toBe(false);
  });

  it("asks Rust again when the window regains focus", async () => {
    subscribeWindowVisible(vi.fn<(visible: boolean) => void>());
    await flush();
    expect(getMainWindowVisibilityMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getMainWindowVisibilityMock).toHaveBeenCalledTimes(2);
  });

  it("stops listening with the last subscriber and forgets what Rust said", async () => {
    getMainWindowVisibilityMock.mockResolvedValue({ visible: false });
    const release = subscribeWindowVisible(vi.fn<(visible: boolean) => void>());
    await flush();
    expect(isWindowVisible()).toBe(false);

    release();
    expect(unlistenMock).toHaveBeenCalledOnce();
    expect(isWindowVisible()).toBe(true);
  });

  it("stays quiet when the page hides on its way out", async () => {
    const seen = vi.fn<(visible: boolean) => void>();
    subscribeWindowVisible(seen);
    await flush();
    seen.mockClear();

    window.dispatchEvent(new Event("pagehide"));
    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(seen).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(seen).toHaveBeenLastCalledWith(false);
  });

  it("still honours a hidden document", async () => {
    subscribeWindowVisible(vi.fn<(visible: boolean) => void>());
    await flush();
    setDocumentVisibility("hidden");
    expect(isWindowVisible()).toBe(false);
  });
});
