import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { useFurnitureModels } from "../useFurnitureModels";

const room = (furniture: RoomMapConfig["furniture"]): RoomMapConfig => ({ ...DEFAULT_ROOM_MAP, furniture });

describe("useFurnitureModels", () => {
  it("keeps the model object of a piece whose reading did not change", () => {
    const sofa = { id: "sofa", type: "sofa" as const, x: 1, y: 2.5, width: 2.2, height: 0.9 };
    const plant = { id: "plant", type: "plant" as const, x: 4, y: 0.2, width: 0.5, height: 0.5 };
    const { result, rerender } = renderHook(({ config }) => useFurnitureModels(config), {
      initialProps: { config: room([sofa, plant]) },
    });
    const before = result.current;

    // The plant moves; the sofa still reads as the same three-seat sofa.
    rerender({ config: room([sofa, { ...plant, x: 3.5 }]) });
    expect(result.current.get("sofa")).toBe(before.get("sofa"));
    expect(result.current.get("plant")).toBe(before.get("plant"));

    // Narrowed into an armchair, the sofa's reading — and so its object — changes.
    rerender({ config: room([{ ...sofa, width: 0.8 }, plant]) });
    expect(result.current.get("sofa")).not.toBe(before.get("sofa"));
    expect(result.current.get("sofa")).toMatchObject({ kind: "upholstered", seats: 1 });
  });
});
