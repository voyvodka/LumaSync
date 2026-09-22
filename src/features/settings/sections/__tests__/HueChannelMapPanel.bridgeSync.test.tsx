// The channel map's bridge sync through the real channel hook, with only the
// Tauri boundary faked: a bridge whose stored layout the test can change, a
// runtime that is idle or lit, and the write-back command.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHueAreaChannels } from "@/features/hue/state/useHueAreaChannels";
import type {
  HueAreaChannelInfo,
  HueChannelPlacementOverride,
  HueChannelWritebackStatus,
} from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { HueChannelMapPanel } from "../HueChannelMapPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${JSON.stringify(opts)}` : key,
  }),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

interface BridgeChannel {
  channelId: number;
  x: number;
  y: number;
  z: number | null;
}

interface FakeWorld {
  bridge: BridgeChannel[];
  runtimeState: "Idle" | "Running";
  writeback: (placements: HueChannelPlacement[]) => HueChannelWritebackStatus;
}

let world: FakeWorld;

function status<C extends string>(code: C, details: string | null = null) {
  return { code, message: code, details };
}

/** Takes every placement it is sent, the way a bridge of plain bulbs does. */
function acceptAll(placements: HueChannelPlacement[]): HueChannelWritebackStatus {
  for (const p of placements) storeOnBridge(p);
  return status("HUE_CHANNEL_POSITIONS_UPDATED");
}

function storeOnBridge(p: HueChannelPlacement) {
  const target = world.bridge.find((b) => b.channelId === p.channelId);
  if (!target) return;
  target.x = p.x;
  target.y = p.y;
  if (p.zOrigin) target.z = p.z;
}

/** While lighting is on, the command answers from the running stream, whose
 *  channels carry our placements rather than the bridge's. */
let echoedPlacements: HueChannelPlacement[] = [];

function channelList(): HueAreaChannelInfo[] {
  return world.bridge.map((b, index) => {
    const echoed = echoedPlacements.find((p) => p.channelId === b.channelId);
    const lit = world.runtimeState !== "Idle" && echoed;
    return {
      index,
      channelId: b.channelId,
      lightIds: [`light-${b.channelId}`],
      positionX: lit ? echoed.x : b.x,
      positionY: lit ? echoed.y : b.y,
      positionZ: lit ? echoed.z : b.z,
      lightCount: 1,
      autoRegion: "center",
    };
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  echoedPlacements = [];
  world = {
    // The layout read off the real bridge on 2026-09-23.
    bridge: [
      { channelId: 0, x: 0.168, y: 1.0, z: -0.524 },
      { channelId: 1, x: -0.563, y: 1.0, z: -0.641 },
    ],
    runtimeState: "Idle",
    writeback: acceptAll,
  };
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "get_hue_stream_status":
        return {
          active: world.runtimeState !== "Idle",
          status: {
            state: world.runtimeState,
            code: "HUE_STREAM_IDLE",
            message: "",
            details: null,
            triggerSource: "system",
          },
        };
      case "get_hue_area_channels":
        return { status: status("HUE_AREA_CHANNELS_OK"), channels: channelList() };
      case "update_hue_channel_positions":
        return world.writeback(args!.channels as HueChannelPlacement[]);
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  // A native confirm would block the webview; nothing may reach for it.
  window.confirm = vi.fn(() => {
    throw new Error("window.confirm must not be used");
  });
});

/** Both channels bound to one zone, heights authored by hand — the state the
 *  hardware run started from. */
const ZONE: HueZone = {
  id: "zone-tv",
  name: "TV wall",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0.5,
  centerZ: -0.2,
  scaleX: 1,
  scaleY: 0.6,
  scaleZ: 0.8,
  channelIndices: [0, 1],
};

function boundPlacements(): HueChannelPlacement[] {
  return [
    {
      channelIndex: 0,
      channelId: 0,
      x: 0.2,
      y: 0.8,
      z: 0.5,
      zOrigin: "user",
      zoneId: ZONE.id,
      zoneRelativePosition: { x: 0.2, y: 0.5, z: 0.875 },
    },
    {
      channelIndex: 1,
      channelId: 1,
      x: -0.5,
      y: 0.8,
      z: -0.2,
      zOrigin: "user",
      zoneId: ZONE.id,
      zoneRelativePosition: { x: -0.5, y: 0.5, z: 0 },
    },
  ];
}

interface HarnessProps {
  initialPlacements: HueChannelPlacement[];
  initialSnapshot?: HueChannelPlacementOverride[];
  zones?: HueZone[];
  onRepair?: () => void;
  onSnapshot?: (snapshot: HueChannelPlacementOverride[]) => void;
}

let latestPlacements: HueChannelPlacement[] = [];
let refresh: () => Promise<unknown> = async () => null;

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" };
const CREDENTIALS = { username: "app-key", clientKey: "psk" };

/** What `DeviceSection` + `HueBridgesCategory` hand the panel, minus the rest
 *  of the Devices page. */
function Harness({ initialPlacements, initialSnapshot, zones = [ZONE], onRepair, onSnapshot }: HarnessProps) {
  const channels = useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1");
  const [placements, setPlacements] = useState(initialPlacements);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  latestPlacements = placements;
  refresh = channels.refreshChannels;
  echoedPlacements = placements;
  return (
    <HueChannelMapPanel
      channels={channels.areaChannels}
      isLoading={channels.isLoadingChannels}
      channelsStatus={channels.channelsStatus}
      channelsFromBridge={channels.channelsFromBridge}
      onRefreshChannels={channels.refreshChannels}
      placements={placements}
      onPositionChange={setPlacements}
      syncedPositions={snapshot}
      onSyncedPositionsChange={(next) => {
        onSnapshot?.(next);
        setSnapshot(next);
      }}
      onRepair={onRepair}
      bridgeIp={BRIDGE.ip}
      username={CREDENTIALS.username}
      areaId="area-1"
      isStreaming={world.runtimeState === "Running"}
      zones={zones}
    />
  );
}

async function renderLoaded(props: HarnessProps) {
  const view = render(<Harness {...props} />);
  await screen.findAllByRole("group");
  return view;
}

async function confirmAction(user: ReturnType<typeof userEvent.setup>, button: RegExp) {
  await user.click(screen.getByRole("button", { name: button }));
  const dialog = await screen.findByRole("dialog");
  const buttons = dialog.querySelectorAll("button");
  await user.click(buttons[buttons.length - 1]!);
}

/** What "validate again" and a stopped stream do. Not awaited inside `act`: the
 *  read settles only after the render `act` would be holding back. */
async function rereadBridge() {
  let settled = false;
  act(() => {
    void refresh().then(() => {
      settled = true;
    });
  });
  await waitFor(() => expect(settled).toBe(true));
}

function syncLine(): string {
  return screen.getByText(/hue:channelMap\.sync\./).textContent ?? "";
}

function byId(id: number) {
  return latestPlacements.find((p) => p.channelId === id)!;
}

// ---------------------------------------------------------------------------

describe("taking the bridge's arrangement", () => {
  it("brings the bridge's height too, re-deriving a zone-bound channel's relative height", async () => {
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await confirmAction(user, /pullFromBridge/);
    await screen.findByText("hue:channelMap.pulled");

    const ch0 = byId(0);
    expect(ch0.z).toBeCloseTo(-0.524, 6);
    expect(ch0.zOrigin).toBe("bridge");
    // (-0.524 - centerZ -0.2) / scaleZ 0.8 — the field the runtime resolves.
    expect(ch0.zoneRelativePosition!.z).toBeCloseTo(-0.405, 6);
    expect(ch0.zoneId).toBe(ZONE.id);
    expect(byId(1).zoneRelativePosition!.z).toBeCloseTo((-0.641 + 0.2) / 0.8, 6);
    expect(byId(1).x).toBeCloseTo(-0.563, 6);
  });

  it("keeps the local height where the bridge reports none", async () => {
    world.bridge[1]!.z = null;
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await confirmAction(user, /pullFromBridge/);
    await screen.findByText("hue:channelMap.pulled");

    expect(byId(1).z).toBeCloseTo(-0.2, 6);
    expect(byId(1).zOrigin).toBe("user");
    expect(byId(1).zoneRelativePosition!.z).toBe(0);
  });

  it("says the bridge has this arrangement afterwards, not that it holds an old one", async () => {
    const snapshots: HueChannelPlacementOverride[][] = [];
    const user = userEvent.setup();
    // What the hardware run had on disk: the last push, not the bridge's layout.
    await renderLoaded({
      initialPlacements: boundPlacements(),
      initialSnapshot: [
        { channelId: 0, positionX: 0.2, positionY: 0.8, positionZ: 0.5 },
        { channelId: 1, positionX: -0.5, positionY: 0.8, positionZ: -0.2 },
      ],
      onSnapshot: (s) => snapshots.push(s),
    });

    await confirmAction(user, /pullFromBridge/);
    await screen.findByText("hue:channelMap.pulled");

    expect(syncLine()).toBe("hue:channelMap.sync.inSync");
    expect(snapshots[snapshots.length - 1]).toEqual([
      { channelId: 0, positionX: 0.168, positionY: 1.0, positionZ: -0.524 },
      { channelId: 1, positionX: -0.563, positionY: 1.0, positionZ: -0.641 },
    ]);
  });

  it("names a channel its zone cannot reach instead of claiming a clean pull", async () => {
    const user = userEvent.setup();
    await renderLoaded({
      initialPlacements: boundPlacements(),
      zones: [{ ...ZONE, centerZ: 0.2, scaleZ: 0.5 }],
    });

    await confirmAction(user, /pullFromBridge/);

    // -0.524 and -0.641 both sit below a zone spanning -0.3 … 0.7.
    expect(await screen.findByText(/hue:channelMap\.pulledClamped/)).toBeTruthy();
    expect(screen.getByText(/hue:channelMap\.pulledClamped/).textContent).toContain("#0, #1");
    expect(byId(0).zoneRelativePosition!.z).toBe(-1);
  });

  it("adopts a fresh read, not the list it already held", async () => {
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });
    world.bridge[0]!.x = -0.9;

    await confirmAction(user, /pullFromBridge/);
    await screen.findByText("hue:channelMap.pulled");

    expect(byId(0).x).toBeCloseTo(-0.9, 6);
  });

  it("refuses a read that answered with our own placements", async () => {
    const user = userEvent.setup();
    const before = boundPlacements();
    await renderLoaded({ initialPlacements: before });
    // A stream started elsewhere after the panel loaded; the Devices view has
    // not polled since, so the button is still enabled.
    world.runtimeState = "Running";

    await confirmAction(user, /pullFromBridge/);

    expect(await screen.findByText("hue:channelMap.pullFailed")).toBeTruthy();
    expect(byId(0).z).toBe(0.5);
  });
});

describe("whether the bridge has this arrangement", () => {
  it("re-reads the bridge rather than trusting the last push", async () => {
    const local = boundPlacements().map((p) => ({ ...p, zOrigin: null }));
    world.bridge = [
      { channelId: 0, x: 0.2, y: 0.8, z: null },
      { channelId: 1, x: -0.5, y: 0.8, z: null },
    ];
    await renderLoaded({
      initialPlacements: local,
      initialSnapshot: [
        { channelId: 0, positionX: 0.2, positionY: 0.8 },
        { channelId: 1, positionX: -0.5, positionY: 0.8 },
      ],
    });
    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.inSync"));

    // Rearranged in the Hue app; the snapshot of our last push still matches.
    world.bridge[1]!.x = 0.4;
    await rereadBridge();

    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.localAhead"));
  });

  it("ignores a read made while lighting is on, which only echoes our own layout", async () => {
    const snapshots: HueChannelPlacementOverride[][] = [];
    const bridgeLayout: HueChannelPlacementOverride[] = [
      { channelId: 0, positionX: 0.168, positionY: 1.0, positionZ: -0.524 },
      { channelId: 1, positionX: -0.563, positionY: 1.0, positionZ: -0.641 },
    ];
    world.runtimeState = "Running";
    await renderLoaded({
      initialPlacements: boundPlacements(),
      initialSnapshot: bridgeLayout,
      onSnapshot: (s) => snapshots.push(s),
    });

    await rereadBridge();

    await waitFor(() => expect(screen.queryByText("hue:channelMap.loading")).toBeNull());
    expect(syncLine()).toBe("hue:channelMap.sync.localAhead");
    expect(snapshots).toEqual([]);
  });

  it("compares height only when both sides carry it", async () => {
    const local = boundPlacements().map((p) => ({ ...p, zOrigin: null }));
    world.bridge = [
      { channelId: 0, x: 0.2, y: 0.8, z: 0.9 },
      { channelId: 1, x: -0.5, y: 0.8, z: -0.9 },
    ];
    await renderLoaded({ initialPlacements: local });

    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.inSync"));
  });
});

describe("saving to the bridge", () => {
  it("counts only the channels the bridge took, and says which it kept", async () => {
    const snapshots: HueChannelPlacementOverride[][] = [];
    world.writeback = (placements) => {
      for (const p of placements) if (p.channelId !== 1) storeOnBridge(p);
      return status(
        "HUE_CHANNEL_POSITIONS_UPDATED",
        "Channel(s) 1 have no single bridge position to write (gradient, grouped or unknown).",
      );
    };
    const user = userEvent.setup();
    await renderLoaded({
      initialPlacements: boundPlacements(),
      onSnapshot: (s) => snapshots.push(s),
    });
    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.localAhead"));
    snapshots.length = 0;

    await confirmAction(user, /saveToBridge$/);

    const notice = await screen.findByText(/hue:channelMap\.savedPartial/);
    expect(notice.textContent).toContain("#1");
    const recorded = snapshots[0]!;
    expect(recorded.find((s) => s.channelId === 0)).toMatchObject({ positionX: 0.2 });
    // Still the bridge's own position, not ours.
    expect(recorded.find((s) => s.channelId === 1)).toMatchObject({ positionX: -0.563 });
    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.localAhead"));
  });

  it("reads the bridge back after a full save and settles in sync", async () => {
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await confirmAction(user, /saveToBridge$/);

    await screen.findByText("hue:channelMap.savedToBridge");
    await waitFor(() => expect(syncLine()).toBe("hue:channelMap.sync.inSync"));
  });

  it("offers a re-pair, not a retry, when the bridge rejects the key", async () => {
    world.writeback = () => status("AUTH_INVALID_RE_PAIR_REQUIRED");
    const onRepair = vi.fn();
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements(), onRepair });

    await confirmAction(user, /saveToBridge$/);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("hue:runtime.writeback.codes.AUTH_INVALID_RE_PAIR_REQUIRED");
    expect(screen.queryByRole("button", { name: /saveToBridgeErrorRetry/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "hue:runtime.actions.repair" }));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("explains an unwritable area without offering a retry that cannot help", async () => {
    world.writeback = () => status("CHAN_WB_UNRESOLVED_CHANNEL");
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await confirmAction(user, /saveToBridge$/);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("hue:runtime.writeback.codes.CHAN_WB_UNRESOLVED_CHANNEL");
    expect(screen.queryByRole("button", { name: /saveToBridgeErrorRetry/ })).toBeNull();
  });
});

describe("confirmation", () => {
  it("asks in the app's own dialog, and Escape sends nothing", async () => {
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await user.click(screen.getByRole("button", { name: /saveToBridge$/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("hue:channelMap.saveConfirmTitle");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("update_hue_channel_positions", expect.anything());
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("cancelling a pull leaves the arrangement alone", async () => {
    const user = userEvent.setup();
    await renderLoaded({ initialPlacements: boundPlacements() });

    await user.click(screen.getByRole("button", { name: /pullFromBridge/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(dialog.querySelectorAll("button")[0]!);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(byId(0).z).toBe(0.5);
  });
});
