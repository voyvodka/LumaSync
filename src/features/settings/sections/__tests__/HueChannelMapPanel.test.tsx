import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import { HueChannelMapPanel, posToPercent } from "../HueChannelMapPanel";

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

/** Bridge ids deliberately gapped: a contiguous fixture passes whether or not
 *  the row addresses the channel by its own id. */
const BRIDGE_IDS = [0, 2, 5];

function makeChannels(): HueAreaChannelInfo[] {
  return BRIDGE_IDS.map((channelId, i) => ({
    index: i,
    channelId,
    lightIds: [`light-${channelId}`],
    positionX: i - 1, // -1, 0, +1 ⇒ left, center, right presets
    positionY: 0,
    lightCount: 2,
    autoRegion: "center",
  }));
}

const defaultProps = {
  channels: makeChannels(),
  isLoading: false,
  channelsStatus: HUE_AREA_CHANNELS_STATUS.OK as string,
};

type PositionSpy = ReturnType<typeof vi.fn<(updated: HueChannelPlacement[]) => void>>;

function lastEmitted(spy: PositionSpy): HueChannelPlacement[] {
  const calls = spy.mock.calls;
  return calls[calls.length - 1]![0];
}

/** Every channel already stored with its bridge id, so the seeding effect stays
 *  quiet and a spy sees only what the click produced. */
function storedAtBridgePositions(): HueChannelPlacement[] {
  return makeChannels().map((ch) => ({
    channelIndex: ch.index,
    channelId: ch.channelId,
    x: ch.positionX,
    y: ch.positionY,
    z: 0,
  }));
}

function pill(row: HTMLElement, preset: string): HTMLElement {
  return within(row).getByRole("radio", { name: `hue:channelMap.regions.${preset}` });
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("group");
}

// ---------------------------------------------------------------------------
// Seeding: the room map is bridge-blind and draws persisted placements only
// ---------------------------------------------------------------------------

describe("seeding persisted placements from the bridge list", () => {
  it("persists a channel the store has never seen", () => {
    const onPositionChange = vi.fn();
    render(
      <HueChannelMapPanel {...defaultProps} placements={[]} onPositionChange={onPositionChange} />,
    );
    expect(onPositionChange).toHaveBeenCalledTimes(1);
    expect(onPositionChange.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ channelIndex: 0, channelId: 0 }),
      expect.objectContaining({ channelIndex: 1, channelId: 2 }),
      expect.objectContaining({ channelIndex: 2, channelId: 5 }),
    ]);
  });

  it("writes nothing when every channel is already stored with its bridge id", () => {
    const onPositionChange = vi.fn();
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={storedAtBridgePositions()}
        onPositionChange={onPositionChange}
      />,
    );
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("re-seeds a placement stored before bridge ids existed", () => {
    const onPositionChange = vi.fn();
    const placements = storedAtBridgePositions().map(({ channelId: _drop, ...rest }) => rest);
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={placements}
        onPositionChange={onPositionChange}
      />,
    );
    expect(onPositionChange).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Channel identity — the bridge's id, raw
// ---------------------------------------------------------------------------

describe("channel identity", () => {
  it("labels each row with the bridge id rather than a 1-based ordinal", () => {
    render(<HueChannelMapPanel {...defaultProps} placements={storedAtBridgePositions()} />);
    expect(screen.getByText("#0")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#5")).toBeTruthy();
    // `#1` / `#3` are what an ordinal, or an ordinal + 1, would have produced.
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.queryByText("#3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Presets write positions — the whole point of the surface
// ---------------------------------------------------------------------------

describe("presets", () => {
  it("writes the preset's position, not a region label", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    const user = userEvent.setup();
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={storedAtBridgePositions()}
        onPositionChange={onPositionChange}
      />,
    );

    await user.click(pill(rows()[0]!, "top"));

    const moved = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    expect(moved.x).toBeCloseTo(0, 6);
    expect(moved.y).toBeCloseTo(1, 6);
  });

  it("moves only the channel whose pill was clicked", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    const user = userEvent.setup();
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={storedAtBridgePositions()}
        onPositionChange={onPositionChange}
      />,
    );

    await user.click(pill(rows()[1]!, "left"));

    const emitted = lastEmitted(onPositionChange);
    expect(emitted.find((p) => p.channelIndex === 1)!.x).toBeCloseTo(-1, 6);
    expect(emitted.find((p) => p.channelIndex === 0)!.x).toBeCloseTo(-1, 6);
    expect(emitted.find((p) => p.channelIndex === 2)!.x).toBeCloseTo(1, 6);
  });

  it("marks the preset the bridge itself put the channel on as derived, not chosen", () => {
    render(<HueChannelMapPanel {...defaultProps} placements={storedAtBridgePositions()} />);
    const left = pill(rows()[0]!, "left");
    expect(left.getAttribute("aria-checked")).toBe("true");
    expect(left.className).toContain("is-derived");
  });

  it("drops the derived mark once the user picks a preset", async () => {
    const user = userEvent.setup();
    render(<HueChannelMapPanel {...defaultProps} placements={storedAtBridgePositions()} />);

    await user.click(pill(rows()[0]!, "top"));

    const near = pill(rows()[0]!, "top");
    expect(near.getAttribute("aria-checked")).toBe("true");
    expect(near.className).not.toContain("is-derived");
  });

  it("says Custom, and checks nothing, for a position on no preset", () => {
    const placements = storedAtBridgePositions();
    placements[0] = { ...placements[0]!, x: 0.42, y: 0.13 };
    render(<HueChannelMapPanel {...defaultProps} placements={placements} />);

    const row = rows()[0]!;
    expect(screen.getByText("hue:channelMap.custom")).toBeTruthy();
    for (const preset of ["left", "right", "top", "bottom", "center"]) {
      expect(pill(row, preset).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("returns the channel to the bridge's own position on reset", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    const user = userEvent.setup();
    const placements = storedAtBridgePositions();
    placements[2] = { ...placements[2]!, x: -0.5, y: 0.5 };
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={placements}
        onPositionChange={onPositionChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /channelMap\.resetToBridge/ }));

    const reset = lastEmitted(onPositionChange).find((p) => p.channelIndex === 2)!;
    expect(reset.x).toBeCloseTo(1, 6);
    expect(reset.y).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Canvas coordinate helper — still used by MiniSpatialPreview
// ---------------------------------------------------------------------------

describe("posToPercent", () => {
  it("puts the far wall at the top of the box and the near wall at the bottom", () => {
    expect(posToPercent(0, 1).top).toBe("0%");
    expect(posToPercent(0, -1).top).toBe("100%");
    expect(posToPercent(-1, 0).left).toBe("0%");
    expect(posToPercent(1, 0).left).toBe("100%");
  });
});

// ---------------------------------------------------------------------------
// Empty-list states — three different facts, three different messages
// ---------------------------------------------------------------------------

describe("empty channel list", () => {
  const cases = [
    [HUE_AREA_CHANNELS_STATUS.EMPTY, "empty"],
    [HUE_AREA_CHANNELS_STATUS.UNREACHABLE, "unreachable"],
    [HUE_AREA_CHANNELS_STATUS.FAILED, "failed"],
  ] as const;

  for (const [code, state] of cases) {
    it(`reads as "${state}" on ${code}`, () => {
      render(<HueChannelMapPanel {...defaultProps} channels={[]} channelsStatus={code} />);
      expect(screen.getByText(`hue:channelMap.state.${state}Heading`)).toBeTruthy();
      for (const other of cases.map(([, s]) => s).filter((s) => s !== state)) {
        expect(screen.queryByText(`hue:channelMap.state.${other}Heading`)).toBeNull();
      }
    });
  }

  it("renders nothing at all before the first answer", () => {
    const { container } = render(
      <HueChannelMapPanel {...defaultProps} channels={[]} channelsStatus={null} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stale list — last-known rows stay, the bridge write does not
// ---------------------------------------------------------------------------

describe("unreachable bridge with last-known channels", () => {
  const staleProps = {
    ...defaultProps,
    channelsStatus: HUE_AREA_CHANNELS_STATUS.UNREACHABLE as string,
    placements: storedAtBridgePositions(),
    bridgeIp: "192.168.1.10",
    username: "test-user-key",
    areaId: "area-uuid-123",
  };

  it("keeps the rows and says they are stale", () => {
    render(<HueChannelMapPanel {...staleProps} />);
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("hue:channelMap.state.staleBody")).toBeTruthy();
  });

  it("refuses the bridge write while the bridge is not answering", () => {
    render(<HueChannelMapPanel {...staleProps} />);
    expect(screen.getByRole("button", { name: /saveToBridge$/ })).toHaveProperty("disabled", true);
  });
});

// ---------------------------------------------------------------------------
// CHAN-05: Save to Bridge write-back
// ---------------------------------------------------------------------------

describe("CHAN-05: save to bridge write-back", () => {
  const writebackProps = {
    ...defaultProps,
    placements: storedAtBridgePositions(),
    bridgeIp: "192.168.1.10",
    username: "test-user-key",
    areaId: "area-uuid-123",
    isStreaming: false,
  };

  it("save button is disabled when isStreaming is true", () => {
    render(<HueChannelMapPanel {...writebackProps} isStreaming={true} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge$/ });
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  it("save button is enabled when isStreaming is false and credentials present", () => {
    render(<HueChannelMapPanel {...writebackProps} isStreaming={false} />);
    const saveBtn = screen.getByRole("button", { name: /saveToBridge$/ });
    expect(saveBtn).toHaveProperty("disabled", false);
  });

  it("cancelling confirm dialog does not invoke write-back", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockClear();
    // happy-dom does not define window.confirm; assign a mock function directly
    window.confirm = vi.fn().mockReturnValueOnce(false);

    const user = userEvent.setup();
    render(<HueChannelMapPanel {...writebackProps} />);
    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));

    expect(mockInvoke).not.toHaveBeenCalledWith("update_hue_channel_positions", expect.anything());
  });

  it("failed write-back shows inline error with retry", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockResolvedValueOnce({
      code: "CHAN_WB_SCHEMA_REJECTED",
      message: "Bridge rejected the format",
    });
    window.confirm = vi.fn().mockReturnValueOnce(true);

    const user = userEvent.setup();
    render(<HueChannelMapPanel {...writebackProps} />);
    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));

    const errorEls = await screen.findAllByText(/channelMap\.saveToBridgeError/);
    expect(errorEls.length).toBeGreaterThan(0);
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
    scaleX: 1,
    scaleY: 1,
    scaleZ: 0.5,
    channelIndices: [0],
  };

  const boundPlacement: HueChannelPlacement = {
    channelIndex: 0,
    channelId: 0,
    x: 0.5,
    y: 0,
    z: 0,
    label: "Sofa lamp",
    locked: true,
    zoneId: "zone-1",
    zoneRelativePosition: { x: 1, y: 0, z: 0 },
  };

  function renderBound(onPositionChange?: PositionSpy) {
    const placements = storedAtBridgePositions();
    placements[0] = boundPlacement;
    render(
      <HueChannelMapPanel
        {...defaultProps}
        placements={placements}
        zones={[ZONE]}
        onPositionChange={onPositionChange}
      />,
    );
  }

  it("keeps the zone binding, label and lock instead of rebuilding a bare record", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    const user = userEvent.setup();
    renderBound(onPositionChange);

    await user.click(pill(rows()[0]!, "left"));

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    expect(channel.zoneId).toBe("zone-1");
    expect(channel.label).toBe("Sofa lamp");
    expect(channel.locked).toBe(true);
  });

  it("writes the zone-relative pair, which is the one the runtime reads", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    const user = userEvent.setup();
    renderBound(onPositionChange);

    await user.click(pill(rows()[0]!, "left"));

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    // centerX 0 + scaleX 1 ⇒ relative -1 for world -1. Writing only the absolute
    // pair would leave the resolved position where it was.
    expect(channel.zoneRelativePosition?.x).toBeCloseTo(-1, 5);
    expect(channel.x).toBeCloseTo(-1, 5);
  });

  it("reads the row's preset from where the zone puts the channel, not its stale absolute pair", () => {
    const placements = storedAtBridgePositions();
    placements[0] = { ...boundPlacement, x: -0.9, y: -0.9 };
    render(<HueChannelMapPanel {...defaultProps} placements={placements} zones={[ZONE]} />);

    // centerX 0 + scaleX 1 * relative 1 ⇒ world +1, which is the `right` preset.
    expect(pill(rows()[0]!, "right").getAttribute("aria-checked")).toBe("true");
    expect(pill(rows()[0]!, "left").getAttribute("aria-checked")).toBe("false");
  });
});
