import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import type { RoomMapDocument } from "../../state/useRoomMapDocument";
import { __resetRoomViewFailure, RoomMapSurface } from "../RoomMapSurface";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn<() => Promise<null>>().mockResolvedValue(null),
}));

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(store.state),
    update: async (fn: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
      const partial = fn(store.state);
      if (partial !== null) store.state = { ...store.state, ...partial };
      return store.state;
    },
  },
}));

// The plan stands in as a button that edits the map and a readout of its history, so a test can
// tell whether the map outlived a switch.
vi.mock("../RoomMapEditor", () => ({
  RoomMapEditor: ({ doc }: { doc: RoomMapDocument }) => (
    <div data-testid="plan" data-can-undo={String(doc.canUndo)}>
      <button
        type="button"
        data-testid="plan-edit"
        onClick={() => doc.apply({ dimensions: { ...doc.config.dimensions, widthMeters: 6 } })}
      />
    </div>
  ),
}));

const viewer = vi.hoisted(() => ({ fail: null as ((error: unknown) => void) | null }));

vi.mock("@/features/room-view/ui/RoomView3DHost", () => ({
  ROOM_VIEW_3D_AVAILABLE: true,
  RoomView3DHost: ({ onFail }: { onFail: (error: unknown) => void }) => {
    viewer.fail = onFail;
    return <div data-testid="room-view-3d" />;
  },
}));

const lampReads = vi.hoisted(() => ({ enabled: [] as boolean[] }));
const lastLampRead = () => lampReads.enabled[lampReads.enabled.length - 1];

vi.mock("../../state/useHueLampFamilies", () => ({
  useHueLampFamilies: (_channels: unknown, enabled: boolean) => {
    lampReads.enabled.push(enabled);
    return new Map();
  },
}));

vi.mock("../TemplateSelector", () => ({
  TemplateSelector: () => <div data-testid="templates" />,
}));

const TV = { x: 2, y: 0.2, width: 1.2, height: 0.1 };

function stored(roomMap: Partial<RoomMapConfig>) {
  store.state = { roomMap: { ...DEFAULT_ROOM_MAP, ...roomMap } };
}

async function renderSurface(props: { view3dAvailable?: boolean } = {}) {
  const view = render(<RoomMapSurface view3dAvailable={props.view3dAvailable ?? true} />);
  await act(async () => {});
  return view;
}

const radio = (name: string) => screen.getByRole("radio", { name });

beforeEach(() => {
  stored({ tvAnchor: TV });
  lampReads.enabled = [];
  viewer.fail = null;
});

afterEach(() => {
  __resetRoomViewFailure();
  vi.restoreAllMocks();
});

describe("RoomMapSurface — faces", () => {
  it("opens on the room where the 3D room is built, and Edit swaps it for the plan", async () => {
    await renderSurface();
    expect(screen.getByTestId("room-view-3d")).toBeInTheDocument();
    expect(screen.queryByTestId("plan")).toBeNull();
    expect(radio("roomMap:face.view")).toHaveAttribute("aria-checked", "true");

    act(() => radio("roomMap:face.edit").click());

    // The face left behind unmounts: no plan rendering under the room, no WebGL context under the plan.
    expect(screen.getByTestId("plan")).toBeInTheDocument();
    expect(screen.queryByTestId("room-view-3d")).toBeNull();

    act(() => radio("roomMap:face.view").click());
    expect(screen.getByTestId("room-view-3d")).toBeInTheDocument();
    expect(screen.queryByTestId("plan")).toBeNull();
  });

  it("keeps the map's history across a switch, because the map is the surface's", async () => {
    await renderSurface();
    act(() => radio("roomMap:face.edit").click());
    act(() => screen.getByTestId("plan-edit").click());
    expect(screen.getByTestId("plan")).toHaveAttribute("data-can-undo", "true");

    act(() => radio("roomMap:face.view").click());
    act(() => radio("roomMap:face.edit").click());

    expect(screen.getByTestId("plan")).toHaveAttribute("data-can-undo", "true");
  });

  // Edit needs them too: a Hue light's inspector names the model the bridge reports.
  it("reads the lamp shapes in either face while the room is open", async () => {
    await renderSurface();
    expect(lastLampRead()).toBe(true);

    act(() => radio("roomMap:face.edit").click());
    expect(lastLampRead()).toBe(true);
  });

  it("keeps keyboard focus on the switch as the arrow keys change the face", async () => {
    await renderSurface();
    const view = radio("roomMap:face.view");
    view.focus();

    act(() => {
      fireEvent.keyDown(view, { key: "ArrowRight" });
    });

    expect(screen.getByTestId("plan")).toBeInTheDocument();
    expect(document.activeElement).toBe(radio("roomMap:face.edit"));
  });

  it("shows the plan alone, with no switch, in a build without the 3D room", async () => {
    await renderSurface({ view3dAvailable: false });
    expect(screen.getByTestId("plan")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });

  it("opens an empty map with no history on the templates, before either face", async () => {
    stored({});
    await renderSurface();
    expect(screen.getByTestId("templates")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
  });

  it("keeps the templates for a map holding only the Hue channels the bridge seeded", async () => {
    stored({ hueChannels: [{ channelIndex: 0, x: 0.5, y: 0, z: 0 }] });
    await renderSurface();
    expect(screen.getByTestId("templates")).toBeInTheDocument();
  });
});

describe("RoomMapSurface — a room that cannot open", () => {
  it("falls back to the plan, logs, and offers the room no more this session", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await renderSurface();

    act(() => viewer.fail?.(new Error("no WebGL")));

    expect(error).toHaveBeenCalled();
    expect(screen.getByTestId("plan")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "roomMap:face.viewUnavailable" })).toBeDisabled();

    first.unmount();
    await renderSurface();
    expect(screen.getByTestId("plan")).toBeInTheDocument();
    expect(screen.queryByTestId("room-view-3d")).toBeNull();
    expect(screen.getByRole("radio", { name: "roomMap:face.viewUnavailable" })).toBeDisabled();
  });
});
