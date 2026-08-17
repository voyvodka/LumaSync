import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import {
  HueChannelMapPanel,
  clampGroupDelta,
  clientToHueCoords,
  posToPercent,
} from "../HueChannelMapPanel";

// Mock i18n — return key as value (with interpolation support)
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key} ${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChannels(count: number): HueAreaChannelInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    positionX: count > 1 ? (i / (count - 1)) * 2 - 1 : 0, // spread across [-1, 1]
    positionY: 0,
    lightCount: 2,
    autoRegion: "center",
  }));
}

const defaultProps = {
  channels: makeChannels(3),
  isLoading: false,
  overrides: {} as Record<number, string>,
  onSetRegion: vi.fn(),
};

// ---------------------------------------------------------------------------
// CHAN-01: channels rendered at positions
// ---------------------------------------------------------------------------

describe("CHAN-01: channels rendered at positions", () => {
  it("renders channel dots for each channel", () => {
    render(<HueChannelMapPanel {...defaultProps} />);
    // Each channel should have a dot button in the position grid
    // We look for all buttons; at minimum 3 channel dots plus region chip buttons exist
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("uses persisted placements over bridge positions when provided", () => {
    const placements: HueChannelPlacement[] = [
      { channelIndex: 0, x: 0.5, y: 0.5, z: 0 },
      { channelIndex: 1, x: -0.5, y: -0.5, z: 0 },
      { channelIndex: 2, x: 0, y: 0, z: 0 },
    ];
    render(<HueChannelMapPanel {...defaultProps} placements={placements} />);
    // Component should render without errors when placements provided
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// CHAN-02: drag to update position
// ---------------------------------------------------------------------------

describe("CHAN-02: drag to update position", () => {
  it("shows mode toggle with Position and Assign Zone options", () => {
    render(<HueChannelMapPanel {...defaultProps} />);
    // ModePillToggle renders both mode buttons in the panel header
    expect(screen.getByText("hue:channelMap.modPosition")).toBeTruthy();
    expect(screen.getByText("hue:channelMap.modAssignZone")).toBeTruthy();
  });

  // Was `expect(true).toBe(true)` with a note that behaviour needed pointer
  // events. Both halves are pure — the y-flip is the part worth pinning, since
  // Hue +y is the far wall while CSS `top` grows downward.
  const RECT = { left: 100, top: 50, width: 400, height: 200 } as DOMRect;

  it("puts the far wall at the top of the canvas and the near wall at the bottom", () => {
    expect(posToPercent(0, 1).top).toBe("0%");
    expect(posToPercent(0, -1).top).toBe("100%");
    expect(posToPercent(-1, 0).left).toBe("0%");
    expect(posToPercent(1, 0).left).toBe("100%");
  });

  it("round-trips a pointer position back to the coordinate it came from", () => {
    for (const [x, y] of [[0, 0], [1, 1], [-1, -1], [0.25, -0.75]]) {
      const { left, top } = posToPercent(x, y);
      const clientX = RECT.left + (parseFloat(left) / 100) * RECT.width;
      const clientY = RECT.top + (parseFloat(top) / 100) * RECT.height;
      const back = clientToHueCoords(clientX, clientY, RECT);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it("clamps a pointer dragged outside the canvas", () => {
    expect(clientToHueCoords(RECT.left - 500, RECT.top - 500, RECT)).toEqual({ x: -1, y: 1 });
    expect(clientToHueCoords(RECT.left + 900, RECT.top + 900, RECT)).toEqual({ x: 1, y: -1 });
  });
});

// ---------------------------------------------------------------------------
// CHAN-03: z-axis height slider
// ---------------------------------------------------------------------------

describe("CHAN-03: z-axis height slider", () => {
  it("shows detail strip with z-slider when a channel is selected", async () => {
    const user = userEvent.setup();
    render(<HueChannelMapPanel {...defaultProps} />);
    // Channel dots are buttons labelled "1", "2", "3" (ch.index + 1)
    // Click channel dot "1" to select it
    const dot1 = screen.getAllByRole("button", { name: "1" })[0];
    await user.click(dot1);
    // Detail strip should appear with slider
    const slider = screen.queryByRole("slider");
    expect(slider).toBeTruthy();
  });

  it("calls onPositionChange when z value changes", async () => {
    const onPositionChange = vi.fn();
    const user = userEvent.setup();
    render(<HueChannelMapPanel {...defaultProps} onPositionChange={onPositionChange} />);
    // Select channel 1 by clicking its dot
    const dot1 = screen.getAllByRole("button", { name: "1" })[0];
    await user.click(dot1);
    // fireEvent.change is more reliable for range inputs in happy-dom
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(onPositionChange).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CHAN-04: multi-select and group drag
// ---------------------------------------------------------------------------

describe("CHAN-04: multi-select and group drag", () => {
  it("supports Shift+click to add to selection in Position mode", async () => {
    const user = userEvent.setup();
    render(<HueChannelMapPanel {...defaultProps} />);
    // Switch to Position mode first
    const positionBtn = screen.getByText("hue:channelMap.modPosition");
    await user.click(positionBtn);
    // Click first channel dot to select it (dot buttons are labelled "1", "2", "3")
    const dot1 = screen.getAllByRole("button", { name: "1" })[0];
    const dot2 = screen.getAllByRole("button", { name: "2" })[0];
    // First click selects channel 1
    fireEvent.click(dot1);
    // Shift+click second dot using fireEvent for reliable shiftKey simulation in happy-dom
    fireEvent.click(dot2, { shiftKey: true });
    // Multi-select count badge should appear (multiSelectCount i18n key)
    const badge = screen.queryByText(/multiSelectCount/);
    expect(badge).toBeTruthy();
  });

  // Was `expect(true).toBe(true)` on the grounds that a direct test "requires
  // export". It does, so the function is exported now: a mutation sweep showed
  // the upper-bound branch was reachable with nothing asserting on it.
  describe("clampGroupDelta", () => {
    const sel = new Set([0, 1]);
    const group = (...xs: number[]) =>
      xs.map((x, i) => ({ channelIndex: i, x, y: 0, z: 0 }));

    it("shortens the delta to whichever member hits the far wall first", () => {
      // 0.9 has 0.1 of headroom, 0.2 has 0.8 — the group may only move 0.1.
      expect(clampGroupDelta(group(0.9, 0.2), sel, 0.5, 0).dx).toBeCloseTo(0.1, 6);
    });

    it("clamps against the near wall the same way", () => {
      expect(clampGroupDelta(group(-0.9, -0.2), sel, -0.5, 0).dx).toBeCloseTo(-0.1, 6);
    });

    it("clamps each axis on its own", () => {
      const rows = [{ channelIndex: 0, x: 0.95, y: -0.95, z: 0 }];
      const { dx, dy } = clampGroupDelta(rows, new Set([0]), 0.5, -0.5);
      expect(dx).toBeCloseTo(0.05, 6);
      expect(dy).toBeCloseTo(-0.05, 6);
    });

    it("leaves a delta that fits alone, and ignores unselected members", () => {
      expect(clampGroupDelta(group(0.1, 0.2), sel, 0.3, 0).dx).toBe(0.3);
      // Channel 1 would overflow but is not selected, so it must not constrain.
      expect(clampGroupDelta(group(0.1, 0.99), new Set([0]), 0.5, 0).dx).toBe(0.5);
    });
  });
});

// ---------------------------------------------------------------------------
// CHAN-05: Save to Bridge write-back
// ---------------------------------------------------------------------------

describe("CHAN-05: save to bridge write-back", () => {
  const writebackProps = {
    ...defaultProps,
    bridgeIp: "192.168.1.10",
    username: "test-user-key",
    areaId: "area-uuid-123",
    isStreaming: false,
  };

  it("save button is disabled when isStreaming is true", () => {
    render(<HueChannelMapPanel {...writebackProps} isStreaming={true} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge/ });
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  it("save button is enabled when isStreaming is false and credentials present", () => {
    render(<HueChannelMapPanel {...writebackProps} isStreaming={false} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge/ });
    expect(saveBtn).toHaveProperty("disabled", false);
  });

  it("cancelling confirm dialog does not invoke write-back", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockClear();
    // happy-dom does not define window.confirm; assign a mock function directly
    window.confirm = vi.fn().mockReturnValueOnce(false);

    const user = userEvent.setup();
    render(<HueChannelMapPanel {...writebackProps} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge/ });
    await user.click(saveBtn);

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "update_hue_channel_positions",
      expect.anything(),
    );
  });

  it("failed write-back shows inline error with retry", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockResolvedValueOnce({
      code: "CHAN_WB_SCHEMA_REJECTED",
      message: "Bridge rejected the format",
    });
    // happy-dom does not define window.confirm; assign a mock function directly
    window.confirm = vi.fn().mockReturnValueOnce(true);

    const user = userEvent.setup();
    render(<HueChannelMapPanel {...writebackProps} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge/ });
    await user.click(saveBtn);

    // Error message should appear — i18n mock returns "key {opts}" format
    // Use findAllByText since the error + retry share the same container text
    const errorEls = await screen.findAllByText(/channelMap\.saveToBridgeError/);
    expect(errorEls.length).toBeGreaterThan(0);
    // Retry button should appear
    const retryBtns = screen.getAllByRole("button", { name: /saveToBridgeErrorRetry/ });
    expect(retryBtns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Zone-bound channels — the panel used to strip the binding on every save
// ---------------------------------------------------------------------------

describe("zone-bound channels survive an edit here", () => {
  const ZONE = {
    id: "zone-1",
    name: "TV wall",
    entertainmentAreaId: "area-1",
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
    channelIndices: [0],
  };

  const boundPlacement: HueChannelPlacement = {
    channelIndex: 0,
    x: 0.5,
    y: 0,
    z: 0,
    label: "Sofa lamp",
    locked: true,
    zoneId: "zone-1",
    zoneRelativePosition: { x: 1, y: 0, z: 0 },
  };

  type PositionSpy = ReturnType<typeof vi.fn<(updated: HueChannelPlacement[]) => void>>;

  function lastEmitted(spy: PositionSpy): HueChannelPlacement[] {
    const calls = spy.mock.calls;
    return calls[calls.length - 1][0];
  }

  async function editZ(onPositionChange: PositionSpy, value: string) {
    const user = userEvent.setup();
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={[boundPlacement]}
        zones={[ZONE]}
        onPositionChange={onPositionChange}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: "1" })[0]);
    fireEvent.change(screen.getByRole("slider"), { target: { value } });
  }

  it("keeps the zone binding, label and lock instead of rebuilding a bare record", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    await editZ(onPositionChange, "0.5");

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    expect(channel.zoneId).toBe("zone-1");
    expect(channel.label).toBe("Sofa lamp");
    expect(channel.locked).toBe(true);
  });

  it("writes the zone-relative height, which is the one the runtime reads", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    await editZ(onPositionChange, "0.5");

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    // world 0.5 through centerZ 0 + scaleZ 0.5 ⇒ relative 1.0. Writing only the
    // absolute `z` would leave the resolved height at its old value.
    expect(channel.zoneRelativePosition?.z).toBeCloseTo(1, 5);
    expect(channel.z).toBeCloseTo(0.5, 5);
  });

  it("paints the bound channel where its zone puts it, not at its stale absolute pair", () => {
    const stale: HueChannelPlacement = { ...boundPlacement, x: -0.9, y: -0.9 };
    render(<HueChannelMapPanel {...defaultProps} placements={[stale]} zones={[ZONE]} />);

    // centerX 0 + scaleX 0.5 * relative 1 ⇒ 0.5, which is 75% across the canvas.
    const dot = screen.getAllByRole("button", { name: "1" })[0];
    expect(dot.style.left).toBe("75%");
  });
});
