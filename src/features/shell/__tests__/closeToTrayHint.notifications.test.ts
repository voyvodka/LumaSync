import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";

const listenMock = vi.hoisted(() =>
  vi.fn<(event: string, handler: () => unknown) => Promise<() => void>>(() => Promise.resolve(() => {})),
);
const stored = vi.hoisted(() => ({ state: {} as Partial<ShellState> }));
const saveMock = vi.hoisted(() => vi.fn<(patch: Partial<ShellState>) => Promise<void>>(() => Promise.resolve()));

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../launchApi", () => ({ readStartHidden: () => Promise.resolve(false) }));
vi.mock("../windowGeometry", () => ({
  persistWindowState: () => Promise.resolve(),
  restoreWindowState: () => Promise.resolve(),
  schedulePersistWindowState: () => {},
}));
vi.mock("../windowShellState", () => ({
  loadShellState: () => Promise.resolve(stored.state),
  saveShellState: (patch: Partial<ShellState>) => saveMock(patch),
}));

import { initCloseToTrayHint } from "../windowLifecycle";

async function closeToTray() {
  const handler = listenMock.mock.calls[listenMock.mock.calls.length - 1]?.[1];
  handler?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the one-time tray hint", () => {
  beforeEach(() => {
    listenMock.mockClear();
    saveMock.mockClear();
  });

  // It is a notification: with them off it cannot show, and marking it shown meant it never would.
  it("waits for a close with notifications on, then shows once", async () => {
    const onFirstClose = vi.fn<() => void>();
    await initCloseToTrayHint(onFirstClose);

    stored.state = { notifications: "off" };
    await closeToTray();
    expect(onFirstClose).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalledWith({ trayHintShown: true });

    stored.state = { notifications: "on" };
    await closeToTray();
    expect(onFirstClose).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith({ trayHintShown: true });
  });
});
