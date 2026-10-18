import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomDropTarget } from "@/features/room-view/ui/RoomView3D";
import { DEFAULT_ROOM_MAP, type RoomCorner, type RoomMapConfig, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import { FURNITURE_DEFAULT_SIZE } from "../../model/furnitureKinds";
import { TV_DEFAULT_FOOTPRINT } from "../../model/libraryDrop";
import type { PlanDropGhostHandle } from "../../ui/drop/PlanDropGhost";
import { type LibraryDropArgs, useLibraryDrop } from "../useLibraryDrop";

const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: { ...DEFAULT_ROOM_MAP.dimensions, widthMeters: 4, depthMeters: 3 } };
const sofa = FURNITURE_DEFAULT_SIZE.sofa;

function rectOf(el: HTMLElement, left: number, top: number) {
  el.getBoundingClientRect = () => ({ left, top, x: left, y: top, width: 800, height: 600, right: left + 800, bottom: top + 600, toJSON: () => ({}) });
}

/** An editor root holding a stage at (10, 20) and, in it, the plan's viewport at (10, 60) or the 3D view. */
function stage(inRoom: boolean) {
  const root = document.createElement("div");
  const stageEl = document.createElement("div");
  stageEl.dataset.testid = "room-map-stage";
  const surface = document.createElement("div");
  if (inRoom) surface.dataset.testid = "room-view-3d";
  else surface.setAttribute("data-room-map-viewport", "");
  const dock = document.createElement("div");
  stageEl.append(surface, dock);
  root.append(stageEl);
  document.body.append(root);
  rectOf(stageEl, 10, 20);
  rectOf(surface, 10, 60);
  // Left of x=500 is the surface; anything right of it is the dock floating over it.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number) => (x < 500 ? surface : dock) });
  return root;
}

function setup(overrides: Partial<LibraryDropArgs> & { inRoom?: boolean; outline?: readonly RoomCorner[] } = {}) {
  const inRoom = overrides.inRoom ?? false;
  const root = stage(inRoom);
  const ghost: PlanDropGhostHandle = { show: vi.fn<PlanDropGhostHandle["show"]>() };
  const room: RoomDropTarget = { floorAt: vi.fn<RoomDropTarget["floorAt"]>(() => ({ x: 0.5, z: -0.5 })), preview: vi.fn<RoomDropTarget["preview"]>(), settle: vi.fn<() => void>(), holdZone: vi.fn<RoomDropTarget["holdZone"]>() };
  const args: LibraryDropArgs = {
    rootRef: { current: root },
    inRoom,
    config,
    outline: resolveRoomFootprint(config),
    pxPerMeter: 80,
    zoom: 0.5,
    panOffset: { x: 30, y: 10 },
    roomDropRef: { current: room },
    ghostRef: { current: ghost },
    onAddFurniture: vi.fn<LibraryDropArgs["onAddFurniture"]>(),
    onAddTv: vi.fn<LibraryDropArgs["onAddTv"]>(),
    onLanded: vi.fn<() => void>(),
    ...overrides,
  };
  const { result } = renderHook(() => useLibraryDrop(args));
  return { drop: result.current, args, ghost, room };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useLibraryDrop", () => {
  // Plan metres at zoom 0.5: 40 px each, from the viewport's corner (10, 60) plus the pan (30, 10).
  const planPoint = (x: number, y: number) => [10 + 30 + x * 40, 60 + 10 + y * 40] as const;

  it("shows the plan's ghost centred under the pointer and adds nothing while held", () => {
    const { drop, args, ghost } = setup();
    expect(drop.hover({ kind: "furniture", type: "sofa" }, ...planPoint(2, 1.5))).toBe(true);
    expect(ghost.show).toHaveBeenCalledWith({
      card: { kind: "furniture", type: "sofa" },
      left: 30 + (2 - sofa.width / 2) * 40,
      top: 40 + 10 + (1.5 - sofa.depth / 2) * 40,
      width: sofa.width * 40,
      height: sofa.depth * 40,
      valid: true,
    });
    expect(args.onAddFurniture).not.toHaveBeenCalled();
    expect(args.onAddTv).not.toHaveBeenCalled();
  });

  it("adds the piece where it was dropped, once, and hands the keys back", () => {
    const { drop, args, ghost } = setup();
    expect(drop.land({ kind: "furniture", type: "sofa" }, ...planPoint(2, 1.5))).toBe(true);
    expect(args.onAddFurniture).toHaveBeenCalledOnce();
    expect(args.onAddFurniture).toHaveBeenCalledWith("sofa", { x: 2 - sofa.width / 2, y: 1.5 - sofa.depth / 2 });
    expect(args.onLanded).toHaveBeenCalledOnce();
    expect(ghost.show).toHaveBeenLastCalledWith(null);
  });

  it("drops nothing over the dock or anything else floating on the stage", () => {
    const { drop, args, ghost } = setup();
    expect(drop.hover({ kind: "furniture", type: "sofa" }, 600, 100)).toBe(false);
    expect(ghost.show).toHaveBeenLastCalledWith(null);
    expect(drop.land({ kind: "furniture", type: "sofa" }, 600, 100)).toBe(false);
    expect(args.onAddFurniture).not.toHaveBeenCalled();
    expect(args.onLanded).not.toHaveBeenCalled();
  });

  it("refuses a piece whose middle falls outside an L-shaped room", () => {
    // The top-right quarter cut away.
    const outline: RoomCorner[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1.5 },
      { x: 4, y: 1.5 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    const { drop, args, ghost } = setup({ outline });
    expect(drop.hover({ kind: "furniture", type: "chair" }, ...planPoint(3, 0.5))).toBe(false);
    expect(ghost.show).toHaveBeenLastCalledWith(expect.objectContaining({ valid: false }));
    expect(drop.land({ kind: "furniture", type: "chair" }, ...planPoint(3, 0.5))).toBe(false);
    expect(args.onAddFurniture).not.toHaveBeenCalled();
  });

  it("in 3D, floats the card's model on the floor the pointer is over and lands a TV there", () => {
    const { drop, args, room } = setup({ inRoom: true });
    expect(drop.hover({ kind: "furniture", type: "sofa" }, 100, 100)).toBe(true);
    expect(room.floorAt).toHaveBeenCalledWith(100, 100);
    // The scene's (0.5, -0.5) is the plan's (2.5, 1) in a 4 × 3 room.
    expect(room.preview).toHaveBeenCalledWith({
      piece: expect.objectContaining({ type: "sofa", x: 2.5 - sofa.width / 2, y: 1 - sofa.depth / 2, width: sofa.width, height: sofa.depth }),
      model: expect.objectContaining({ kind: expect.any(String) }),
      valid: true,
    });
    expect(drop.land({ kind: "tv" }, 100, 100)).toBe(true);
    expect(args.onAddTv).toHaveBeenCalledWith({ x: 2.5 - TV_DEFAULT_FOOTPRINT.width / 2, y: 1 - TV_DEFAULT_FOOTPRINT.depth / 2 });
    expect(room.settle).toHaveBeenCalledOnce();
  });

  it("clears the ghost on cancel", () => {
    const { drop, room, ghost } = setup();
    drop.hover({ kind: "furniture", type: "sofa" }, ...planPoint(2, 1.5));
    drop.cancel();
    expect(ghost.show).toHaveBeenLastCalledWith(null);
    expect(room.preview).toHaveBeenLastCalledWith(null);
  });
});
