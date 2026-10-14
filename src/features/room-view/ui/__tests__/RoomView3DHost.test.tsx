import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { RoomView3DHost } from "../RoomView3DHost";

const windowState = vi.hoisted(() => ({ visible: true }));

vi.mock("@/features/shell/windowVisibility", () => ({
  useWindowVisible: () => windowState.visible,
}));

vi.mock("../RoomView3D", () => ({
  default: () => <div data-testid="room-view-3d-canvas" />,
}));

const PROPS = { config: DEFAULT_ROOM_MAP, label: "Room", onFail: () => {} };

describe("RoomView3DHost", () => {
  it("mounts the view while the window is visible", async () => {
    windowState.visible = true;
    render(<RoomView3DHost {...PROPS} />);
    expect(await screen.findByTestId("room-view-3d-canvas")).toBeInTheDocument();
  });

  it("unmounts the view, and with it the WebGL context, when the window hides", async () => {
    windowState.visible = true;
    const { rerender } = render(<RoomView3DHost {...PROPS} />);
    await screen.findByTestId("room-view-3d-canvas");

    windowState.visible = false;
    rerender(<RoomView3DHost {...PROPS} />);

    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });
});
