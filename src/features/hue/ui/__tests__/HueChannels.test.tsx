import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import { bridgeAction } from "./channelsMenu";
import { HueChannels } from "../HueChannels";

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
    positionZ: null,
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

function rows(): HTMLElement[] {
  return screen.getAllByRole("group");
}

type User = ReturnType<typeof userEvent.setup>;

/** Push and pull ask in the app's own dialog; its last button confirms. */
async function answerDialog(user: User, confirm: boolean) {
  const dialog = await screen.findByRole("dialog");
  const buttons = dialog.querySelectorAll("button");
  await user.click(confirm ? buttons[buttons.length - 1]! : buttons[0]!);
}

async function clickAndConfirm(user: User, which: "save" | "pull") {
  await user.click(bridgeAction(which));
  await answerDialog(user, true);
}

// ---------------------------------------------------------------------------
// Seeding: the room map is bridge-blind and draws persisted placements only
// ---------------------------------------------------------------------------

describe("seeding persisted placements from the bridge list", () => {
  it("persists a channel the store has never seen", () => {
    const onPositionChange = vi.fn();
    render(
      <HueChannels {...defaultProps} placements={[]} onPositionChange={onPositionChange} />,
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
      <HueChannels
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
      <HueChannels
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
    render(<HueChannels {...defaultProps} placements={storedAtBridgePositions()} />);
    expect(screen.getByText("#0")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("#5")).toBeTruthy();
    // `#1` / `#3` are what an ordinal, or an ordinal + 1, would have produced.
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.queryByText("#3")).toBeNull();
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
      render(<HueChannels {...defaultProps} channels={[]} channelsStatus={code} />);
      expect(screen.getByText(`hue:channelMap.state.${state}Heading`)).toBeTruthy();
      for (const other of cases.map(([, s]) => s).filter((s) => s !== state)) {
        expect(screen.queryByText(`hue:channelMap.state.${other}Heading`)).toBeNull();
      }
    });
  }

  it("renders nothing at all before the first answer", () => {
    const { container } = render(
      <HueChannels {...defaultProps} channels={[]} channelsStatus={null} />,
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
    render(<HueChannels {...staleProps} />);
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("hue:channelMap.state.staleBody")).toBeTruthy();
  });

  it("refuses the bridge write while the bridge is not answering", () => {
    render(<HueChannels {...staleProps} />);
    expect(bridgeAction("save")).toHaveProperty("disabled", true);
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
    render(<HueChannels {...writebackProps} isStreaming={true} />);
    const saveBtn = bridgeAction("save");
    expect(saveBtn).toHaveProperty("disabled", true);
  });

  // A disabled button never shows its title, so the reason used to be invisible.
  it("says why save and pull are off while streaming, as text on the page (H-9)", () => {
    render(<HueChannels {...writebackProps} isStreaming={true} />);
    const note = screen.getByTestId("hue-chmap-streaming-note");
    expect(note).toHaveTextContent("hue:channelMap.streamingNote");
    // Behind "…", both actions are off, and each is described by the line that says why.
    for (const item of [bridgeAction("save"), bridgeAction("pull")]) {
      expect(item).toBeDisabled();
      expect(item).toHaveAccessibleDescription("hue:channelMap.streamingNote");
    }
  });

  it("shows no streaming note while idle", () => {
    render(<HueChannels {...writebackProps} isStreaming={false} />);
    expect(screen.queryByTestId("hue-chmap-streaming-note")).toBeNull();
  });

  it("save button is enabled when isStreaming is false and credentials present", () => {
    render(<HueChannels {...writebackProps} isStreaming={false} />);
    const saveBtn = bridgeAction("save");
    expect(saveBtn).toHaveProperty("disabled", false);
  });

  it("cancelling confirm dialog does not invoke write-back", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockClear();

    const user = userEvent.setup();
    render(<HueChannels {...writebackProps} />);
    await user.click(bridgeAction("save"));
    await answerDialog(user, false);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("update_hue_channel_positions", expect.anything());
  });

  it("failed write-back shows inline error with retry", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockResolvedValueOnce({
      code: "CHAN_WB_SCHEMA_REJECTED",
      message: "Bridge rejected the format",
    });

    const user = userEvent.setup();
    render(<HueChannels {...writebackProps} />);
    await clickAndConfirm(user, "save");

    const errorEls = await screen.findAllByText(/channelMap\.saveToBridgeError/);
    expect(errorEls.length).toBeGreaterThan(0);
    expect(errorEls[0].textContent).toContain("hue:runtime.writeback.codes.CHAN_WB_SCHEMA_REJECTED");
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
      <HueChannels
        {...defaultProps}
        placements={placements}
        zones={[ZONE]}
        onPositionChange={onPositionChange}
        channelsFromBridge
        bridgeIp="192.168.1.10"
        username="test-user-key"
        areaId="area-uuid-123"
      />,
    );
  }

  /** Pull is the only write this panel makes now, so it is where the
   *  zone-preservation guarantees have to hold. */
  async function pull(onPositionChange: PositionSpy) {
    const user = userEvent.setup();
    renderBound(onPositionChange);
    await clickAndConfirm(user, "pull");
    await screen.findByText(/hue:channelMap\.pulled/);
  }

  it("keeps the zone binding, label and lock instead of rebuilding a bare record", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    await pull(onPositionChange);

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    expect(channel.zoneId).toBe("zone-1");
    expect(channel.label).toBe("Sofa lamp");
    expect(channel.locked).toBe(true);
  });

  it("writes the zone-relative pair, which is the one the runtime reads", async () => {
    const onPositionChange: PositionSpy = vi.fn();
    await pull(onPositionChange);

    const channel = lastEmitted(onPositionChange).find((p) => p.channelIndex === 0)!;
    // Channel 0's bridge position is -1; centerX 0 + scaleX 1 ⇒ relative -1.
    // Writing only the absolute pair would leave the resolved position where it was.
    expect(channel.zoneRelativePosition?.x).toBeCloseTo(-1, 5);
    expect(channel.x).toBeCloseTo(-1, 5);
  });

  it("names the zone a channel belongs to, and nothing for one in none", () => {
    // Two zones, and the bound channel is the FIRST row while its zone is the
    // SECOND entry — so resolving by list position picks the wrong name.
    const other = { ...ZONE, id: "zone-0", name: "Behind sofa", channelIndices: [] };
    const placements = storedAtBridgePositions();
    placements[0] = boundPlacement;
    render(
      <HueChannels {...defaultProps} placements={placements} zones={[other, ZONE]} />,
    );

    expect(screen.getByText("TV wall")).toBeTruthy();
    expect(screen.queryByText("Behind sofa")).toBeNull();
    // A channel in no zone says nothing about zones: an absence is not a value.
    expect(rows()[1]).not.toHaveTextContent(/zone|sofa|TV wall/i);
  });
});

// ---------------------------------------------------------------------------
// Bridge sync — what the bridge holds versus what we hold
// ---------------------------------------------------------------------------

describe("bridge sync state", () => {
  const syncProps = {
    ...defaultProps,
    placements: storedAtBridgePositions(),
    bridgeIp: "192.168.1.10",
    username: "test-user-key",
    areaId: "area-uuid-123",
    isStreaming: false,
  };

  const matchingSnapshot = () =>
    storedAtBridgePositions().map((p) => ({
      channelId: p.channelId!,
      positionX: p.x,
      positionY: p.y,
    }));

  it("says the bridge's arrangement is unknown with neither a read nor a snapshot", () => {
    render(<HueChannels {...syncProps} />);
    expect(screen.getByText("hue:channelMap.sync.unknownShort")).toBeTruthy();
  });

  it("says the bridge has this arrangement when the snapshot matches", () => {
    render(<HueChannels {...syncProps} syncedPositions={matchingSnapshot()} />);
    expect(screen.getByText("hue:channelMap.sync.inSyncShort")).toBeTruthy();
  });

  it("reports an unpushed edit without calling it a fault", () => {
    const moved = storedAtBridgePositions();
    moved[0] = { ...moved[0]!, x: 0.6 };
    render(
      <HueChannels
        {...syncProps}
        placements={moved}
        syncedPositions={matchingSnapshot()}
      />,
    );

    expect(screen.getByText("hue:channelMap.sync.localAheadShort")).toBeTruthy();
  });

  it("records what was pushed, so the state survives a restart", async () => {
    const { invoke: mockInvoke } = await import("@tauri-apps/api/core");
    vi.mocked(mockInvoke).mockResolvedValueOnce({
      code: "HUE_CHANNEL_POSITIONS_UPDATED",
      details: null,
    });
    const onSyncedPositionsChange = vi.fn();

    const user = userEvent.setup();
    render(
      <HueChannels {...syncProps} onSyncedPositionsChange={onSyncedPositionsChange} />,
    );
    await clickAndConfirm(user, "save");

    await vi.waitFor(() => expect(onSyncedPositionsChange).toHaveBeenCalled());
    expect(onSyncedPositionsChange.mock.calls[0]![0]).toEqual([
      { channelId: 0, positionX: -1, positionY: 0 },
      { channelId: 2, positionX: 0, positionY: 0 },
      { channelId: 5, positionX: 1, positionY: 0 },
    ]);
  });

  it("asks before taking the bridge's arrangement, because it replaces yours", async () => {
    const onPositionChange = vi.fn();

    const user = userEvent.setup();
    render(
      <HueChannels {...syncProps} channelsFromBridge onPositionChange={onPositionChange} />,
    );
    onPositionChange.mockClear();
    await user.click(bridgeAction("pull"));
    expect(screen.getByRole("dialog").textContent).toContain("hue:channelMap.pullConfirmTitle");
    await answerDialog(user, false);

    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("adopts the bridge's positions and records them as the bridge's", async () => {
    const onPositionChange = vi.fn();
    const onSyncedPositionsChange = vi.fn();
    const moved = storedAtBridgePositions();
    moved[0] = { ...moved[0]!, x: 0.6, y: 0.6 };

    const user = userEvent.setup();
    render(
      <HueChannels
        {...syncProps}
        placements={moved}
        onPositionChange={onPositionChange}
        onSyncedPositionsChange={onSyncedPositionsChange}
        onRefreshChannels={async () => ({
          status: HUE_AREA_CHANNELS_STATUS.OK,
          channels: makeChannels(),
          fromBridge: true,
        })}
      />,
    );
    onPositionChange.mockClear();
    await clickAndConfirm(user, "pull");

    await vi.waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    const adopted = onPositionChange.mock.calls[0]![0];
    // Channel 0's bridge position is (-1, 0); the local edit is discarded.
    expect(adopted.find((p: { channelIndex: number }) => p.channelIndex === 0).x).toBeCloseTo(-1, 6);
    expect(onSyncedPositionsChange).toHaveBeenLastCalledWith([
      { channelId: 0, positionX: -1, positionY: 0 },
      { channelId: 2, positionX: 0, positionY: 0 },
      { channelId: 5, positionX: 1, positionY: 0 },
    ]);
  });

  it("re-reads the bridge first, because a list fetched mid-stream is ours", async () => {
    const onRefreshChannels = vi.fn(async () => null);

    const user = userEvent.setup();
    render(<HueChannels {...syncProps} onRefreshChannels={onRefreshChannels} />);
    await clickAndConfirm(user, "pull");

    expect(onRefreshChannels).toHaveBeenCalled();
    expect(await screen.findByText("hue:channelMap.pullFailed")).toBeTruthy();
  });

  it("refuses to take the bridge's arrangement while the runtime holds the channels", () => {
    render(<HueChannels {...syncProps} isStreaming={true} />);
    expect(bridgeAction("pull")).toHaveProperty(
      "disabled",
      true,
    );
  });
});

