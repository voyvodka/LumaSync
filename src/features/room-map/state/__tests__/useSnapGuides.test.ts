import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { furnitureObjectId } from "../../model/objectId";
import { useSnapGuides } from "../useSnapGuides";

// The TV's left edge sits at x = 1; the sofa's is dragged near it, well clear of
// the room-centre origin every drag also snaps to.
const CONFIG: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  tvAnchor: { x: 1, y: 0.3, width: 2, height: 0.1 },
  furniture: [{ id: "sofa", type: "sofa", x: 3, y: 2, width: 1, height: 0.5 }],
};
const SOFA = furnitureObjectId("sofa");

const snapPreference = vi.hoisted(() => ({ on: true }));
vi.mock("@/features/persistence/preferences", () => ({ usePreference: () => snapPreference.on }));

/** The guides live in the editor, so a render of this hook is a render of it. */
function renderCounted() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useSnapGuides(CONFIG);
  });
  return { ...hook, renders: () => renders };
}

describe("useSnapGuides — only a change in the guides re-renders", () => {
  it("does not re-render for a drag move that leaves the guides as they were", () => {
    const { result, renders } = renderCounted();
    const start = renders();

    // Far from everything, the walls too: no guides, and there were none. The first move says a
    // drag began (the plan shows its grid then), and none after it renders again.
    for (let i = 0; i < 10; i++) {
      act(() => void result.current.onDragMove(SOFA, 3.6 + i * 0.01, 3.1, 1, 0.5));
    }
    expect(renders()).toBe(start + 1);
    expect(result.current.dragging).toBe(true);
  });

  it("re-renders once on entering a snap and not again while it holds", () => {
    const { result, renders } = renderCounted();
    const start = renders();

    act(() => void result.current.onDragMove(SOFA, 1.02, 3.1, 1, 0.5));
    expect(result.current.guides.length).toBeGreaterThan(0);
    expect(renders()).toBe(start + 1);

    act(() => void result.current.onDragMove(SOFA, 1.03, 3.1, 1, 0.5));
    act(() => void result.current.onDragMove(SOFA, 1.01, 3.1, 1, 0.5));
    expect(renders()).toBe(start + 1);

    act(() => result.current.onDragEnd());
    expect(result.current.guides).toEqual([]);
    expect(renders()).toBe(start + 2);
  });

  it("a drag end with no guides showing is free", () => {
    const { result, renders } = renderCounted();
    const start = renders();
    act(() => result.current.onDragEnd());
    expect(renders()).toBe(start);
  });
});

describe("useSnapGuides — reach and switches", () => {
  // The TV's left edge is at x = 1.
  const mover = (metresPerPx: number) => {
    const hook = renderHook(() => useSnapGuides(CONFIG, metresPerPx));
    const move = (x: number, extra?: { free?: boolean }) => {
      let snap!: ReturnType<typeof hook.result.current.onDragMove>;
      act(() => {
        snap = hook.result.current.onDragMove(SOFA, x, 3.1, 1, 0.5, extra);
      });
      return snap;
    };
    return { ...hook, move };
  };

  it("catches within its screen radius at the zoom given, and lets go only further out", () => {
    // 100 px a metre: catches within 10 cm, holds to 14 cm.
    const { move } = mover(1 / 100);
    expect(move(1.12).snapX).toBeNull();
    expect(move(1.08).snapX).toBeCloseTo(1);
    expect(move(1.12).snapX).toBeCloseTo(1);
    expect(move(1.15).snapX).toBeNull();
  });

  it("never reaches past 15 cm, however small the room is fitted", () => {
    expect(mover(1 / 20).move(1.13).snapX).toBeNull();
  });

  it("starts a drag afresh: a hold from the last one does not carry over", () => {
    const { result, move } = mover(1 / 100);
    move(1.05);
    act(() => result.current.onDragEnd());
    expect(move(1.12).snapX).toBeNull();
  });

  it("moves free while ⌥ is held, and when snapping to objects is off", () => {
    const { rerender, move } = mover(1 / 100);
    expect(move(1.05, { free: true })).toEqual({ snapX: null, snapY: null, guides: [] });
    snapPreference.on = false;
    rerender();
    expect(move(1.05).snapX).toBeNull();
    snapPreference.on = true;
  });
});
