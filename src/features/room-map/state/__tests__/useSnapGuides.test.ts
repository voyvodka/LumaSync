import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

    // Far from everything: no guides, and there were none.
    for (let i = 0; i < 10; i++) {
      act(() => void result.current.onDragMove(SOFA, 4 + i * 0.01, 3.1, 1, 0.5));
    }
    expect(renders()).toBe(start);
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
