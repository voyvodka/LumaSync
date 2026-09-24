import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { furnitureObjectId } from "../../model/objectId";
import {
  GESTURE_COALESCE_MS,
  MAX_HISTORY,
  initialRoomMapState,
  roomMapReducer,
  type RoomMapAction,
  type RoomMapState,
} from "../roomMapReducer";

const SOFA = { id: "sofa", type: "sofa" as const, x: 1, y: 1, width: 2, height: 1 };

function loaded(config: Partial<RoomMapConfig> = {}): RoomMapState {
  return roomMapReducer(initialRoomMapState(), {
    type: "hydrate",
    config: { ...DEFAULT_ROOM_MAP, furniture: [SOFA], ...config },
  });
}

function run(state: RoomMapState, ...actions: RoomMapAction[]): RoomMapState {
  return actions.reduce(roomMapReducer, state);
}

const moveSofa = (x: number): RoomMapAction => ({
  type: "apply",
  patch: (cfg) => ({ furniture: cfg.furniture.map((f) => (f.id === "sofa" ? { ...f, x } : f)) }),
});

const nudge = (x: number, at: number, continued = false): RoomMapAction => ({
  ...(moveSofa(x) as Extract<RoomMapAction, { type: "apply" }>),
  gesture: { key: "nudge:furniture-sofa", at, continued },
});

describe("roomMapReducer — apply", () => {
  it("pushes the previous config and clears redo", () => {
    const s = run(loaded(), moveSofa(2), { type: "undo" }, moveSofa(3));
    expect(s.past).toHaveLength(1);
    expect(s.future).toHaveLength(0);
    expect(s.config.furniture[0]?.x).toBe(3);
  });

  it("asks for an immediate save outside a gesture", () => {
    const before = loaded();
    const s = run(before, moveSofa(2));
    expect(s.saveSeq).toBe(before.saveSeq + 1);
    expect(s.saveDeferred).toBe(false);
  });

  it("resolves an updater against the state it lands on, not the one it was created from", () => {
    // Two edits dispatched in one tick: with a captured `config` the second
    // would silently revert the first.
    const s = run(
      loaded(),
      { type: "apply", patch: (cfg) => ({ furniture: [...cfg.furniture, { ...SOFA, id: "chair" }] }) },
      moveSofa(4),
    );
    expect(s.config.furniture.map((f) => f.id)).toEqual(["sofa", "chair"]);
    expect(s.config.furniture[0]?.x).toBe(4);
  });

  it("replaces instead of merging when asked, so an absent key really goes", () => {
    const s = run(loaded({ tvAnchor: { x: 0, y: 0, width: 1, height: 0.1 } }), {
      type: "apply",
      patch: DEFAULT_ROOM_MAP,
      replace: true,
    });
    expect(s.config).toEqual(DEFAULT_ROOM_MAP);
    expect(s.config.tvAnchor).toBeUndefined();
  });

  it("caps history at MAX_HISTORY", () => {
    let s = loaded();
    for (let i = 0; i < MAX_HISTORY + 10; i++) s = roomMapReducer(s, moveSofa(i));
    expect(s.past).toHaveLength(MAX_HISTORY);
  });
});

describe("roomMapReducer — gestures", () => {
  it("folds consecutive applies under one key inside the window into one undo step", () => {
    const s = run(loaded(), nudge(1.1, 1000), nudge(1.2, 1030), nudge(1.3, 1060));
    expect(s.past).toHaveLength(1);
    expect(s.config.furniture[0]?.x).toBe(1.3);

    const undone = roomMapReducer(s, { type: "undo" });
    expect(undone.config.furniture[0]?.x).toBe(1);
  });

  it("defers the save while the gesture is open", () => {
    const s = run(loaded(), nudge(1.1, 1000));
    expect(s.saveDeferred).toBe(true);
  });

  it("starts a new step once the window has passed", () => {
    const s = run(loaded(), nudge(1.1, 1000), nudge(1.2, 1000 + GESTURE_COALESCE_MS + 1));
    expect(s.past).toHaveLength(2);
  });

  it("keeps an auto-repeat in the gesture however long the OS waited to repeat", () => {
    const s = run(loaded(), nudge(1.1, 1000), nudge(1.2, 1000 + GESTURE_COALESCE_MS * 3, true));
    expect(s.past).toHaveLength(1);
  });

  it("starts a new step for a different key", () => {
    const other: RoomMapAction = {
      type: "apply",
      patch: { dimensions: { ...DEFAULT_ROOM_MAP.dimensions, widthMeters: 9 } },
      gesture: { key: "something-else", at: 1010 },
    };
    const s = run(loaded(), nudge(1.1, 1000), other);
    expect(s.past).toHaveLength(2);
  });

  it("closes the gesture on any plain apply, undo or adopt", () => {
    for (const breaker of [moveSofa(5), { type: "undo" } as const, { type: "adopt", patch: {} } as const]) {
      const s = run(loaded(), nudge(1.1, 1000), breaker, nudge(1.2, 1010));
      const expected = breaker.type === "undo" ? 1 : breaker.type === "adopt" ? 2 : 3;
      expect(s.past).toHaveLength(expected);
    }
  });
});

describe("roomMapReducer — adopt", () => {
  it("changes the config and saves, but is not undoable", () => {
    const before = run(loaded(), moveSofa(2));
    const s = roomMapReducer(before, {
      type: "adopt",
      patch: { hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }] },
    });
    expect(s.config.hueChannels).toHaveLength(1);
    expect(s.past).toBe(before.past);
    expect(s.future).toBe(before.future);
    expect(s.saveSeq).toBe(before.saveSeq + 1);
    expect(s.saveDeferred).toBe(false);
  });
});

describe("roomMapReducer — undo / redo", () => {
  it("round-trips and saves each step", () => {
    const edited = run(loaded(), moveSofa(2));
    const undone = roomMapReducer(edited, { type: "undo" });
    expect(undone.config.furniture[0]?.x).toBe(1);
    expect(undone.saveSeq).toBe(edited.saveSeq + 1);
    const redone = roomMapReducer(undone, { type: "redo" });
    expect(redone.config.furniture[0]?.x).toBe(2);
    expect(redone.saveSeq).toBe(undone.saveSeq + 1);
  });

  it("is a no-op with nothing to undo or redo", () => {
    const s = loaded();
    expect(roomMapReducer(s, { type: "undo" })).toBe(s);
    expect(roomMapReducer(s, { type: "redo" })).toBe(s);
  });

  it("drops a selection whose object the undo took away", () => {
    const added = run(
      loaded({ furniture: [] }),
      { type: "apply", patch: { furniture: [SOFA] } },
      { type: "select", objectId: furnitureObjectId("sofa") },
    );
    expect(added.selection.objectId).toBe(furnitureObjectId("sofa"));
    expect(roomMapReducer(added, { type: "undo" }).selection.objectId).toBeNull();
  });
});

describe("roomMapReducer — selection", () => {
  it("selecting a Hue zone clears the object selection, clearing it does not", () => {
    const withObject = run(loaded(), { type: "select", objectId: furnitureObjectId("sofa") });
    const cleared = roomMapReducer(withObject, { type: "selectHueZone", hueZoneId: null });
    expect(cleared.selection.objectId).toBe(furnitureObjectId("sofa"));
    const zoned = roomMapReducer(withObject, { type: "selectHueZone", hueZoneId: "z1" });
    expect(zoned.selection).toEqual({ objectId: null, hueZoneId: "z1" });
  });

  it("does not touch history or saving", () => {
    const s = loaded();
    const selected = roomMapReducer(s, { type: "select", objectId: furnitureObjectId("sofa") });
    expect(selected.past).toBe(s.past);
    expect(selected.saveSeq).toBe(s.saveSeq);
  });
});
