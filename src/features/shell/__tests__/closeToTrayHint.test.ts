import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.hoisted(() =>
  vi.fn<(event: string, handler: () => unknown) => Promise<() => void>>(() =>
    Promise.resolve(() => {}),
  ),
);
const outerSizeMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ width: number; height: number }>>(),
);

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => Promise.resolve({ get: () => Promise.resolve(null), set: () => Promise.resolve() }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerSize: () => outerSizeMock(),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
  }),
}));
vi.mock("../launchApi", () => ({ readStartHidden: () => Promise.resolve(false) }));

import { initCloseToTrayHint } from "../windowLifecycle";

describe("close-to-tray listener", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listenMock.mockClear();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // The listener's return value is dropped by the event bus, so a rejection
  // there never reached the log sink — only the webview's own console.
  it("logs a failed window-state save instead of leaving it unhandled", async () => {
    outerSizeMock.mockRejectedValue(new Error("window gone"));
    const onFirstClose = vi.fn();
    await initCloseToTrayHint(onFirstClose);

    const [event, handler] = listenMock.mock.calls[0]!;
    expect(event).toBe("shell:close-to-tray");
    expect(handler()).toBeUndefined();

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[LumaSync] close-to-tray: saving window state failed:",
        expect.any(Error),
      );
    });
    expect(onFirstClose).not.toHaveBeenCalled();
  });
});
