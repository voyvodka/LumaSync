import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WindowPresence } from "@/features/shell/windowVisibility";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { COVERED_KEEP_MS, RoomView3DHost } from "../RoomView3DHost";

const windowState = vi.hoisted(() => ({ presence: "visible" as WindowPresence, mounts: 0 }));

vi.mock("@/features/shell/windowVisibility", () => ({
  useWindowPresence: () => windowState.presence,
}));

vi.mock("../RoomView3D", async () => {
  const { useEffect } = await import("react");
  return {
    default: function Canvas() {
      useEffect(() => {
        windowState.mounts += 1;
      }, []);
      return <div data-testid="room-view-3d-canvas" />;
    },
  };
});

const PROPS = { config: DEFAULT_ROOM_MAP, label: "Room", onFail: () => {} };

async function mounted() {
  windowState.presence = "visible";
  windowState.mounts = 0;
  const view = render(<RoomView3DHost {...PROPS} />);
  await screen.findByTestId("room-view-3d-canvas");
  return view;
}

function become(presence: WindowPresence, rerender: (ui: ReactElement) => void) {
  windowState.presence = presence;
  rerender(<RoomView3DHost {...PROPS} />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomView3DHost", () => {
  it("mounts the view while the window is visible", async () => {
    await mounted();
    expect(windowState.mounts).toBe(1);
  });

  it("unmounts the view, and with it the WebGL context, at once when the window is put away", async () => {
    const { rerender } = await mounted();
    become("hidden", rerender);
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });

  it("keeps the view while another window covers this one, and lets it go after a while", async () => {
    const { rerender } = await mounted();
    vi.useFakeTimers();

    become("covered", rerender);
    act(() => vi.advanceTimersByTime(COVERED_KEEP_MS - 1));
    expect(screen.getByTestId("room-view-3d-canvas")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });

  it("is the same view when the window comes back in time, however often", async () => {
    const { rerender } = await mounted();
    vi.useFakeTimers();

    for (let i = 0; i < 3; i += 1) {
      become("covered", rerender);
      act(() => vi.advanceTimersByTime(COVERED_KEEP_MS - 1));
      become("visible", rerender);
    }
    act(() => vi.advanceTimersByTime(COVERED_KEEP_MS));
    expect(screen.getByTestId("room-view-3d-canvas")).toBeInTheDocument();
    expect(windowState.mounts).toBe(1);
  });

  it("builds no view for a window that opens covered, or comes back from the tray covered", async () => {
    windowState.presence = "covered";
    windowState.mounts = 0;
    const { rerender } = render(<RoomView3DHost {...PROPS} />);
    await act(async () => {});
    expect(screen.queryByTestId("room-view-3d")).toBeNull();

    become("visible", rerender);
    await screen.findByTestId("room-view-3d-canvas");
    become("hidden", rerender);
    become("covered", rerender);
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });

  it("lets a covered view go at once when the window is then put away", async () => {
    const { rerender } = await mounted();
    become("covered", rerender);
    become("hidden", rerender);
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });
});
