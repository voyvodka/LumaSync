import { useMemo, useRef } from "react";

import { classifyFurniture, type FurnitureModel } from "@/features/room-view/model/furnitureModel";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

/** Each piece's model for the plan, as the 3D room reads it. A piece whose reading did not change
 *  keeps the same model object, so an edit to one piece re-renders only the pieces it changed —
 *  the plan's objects are memos. */
export function useFurnitureModels(config: RoomMapConfig): ReadonlyMap<string, FurnitureModel> {
  const previous = useRef(new Map<string, { key: string; model: FurnitureModel }>());
  return useMemo(() => {
    const next = new Map<string, { key: string; model: FurnitureModel }>();
    const models = new Map<string, FurnitureModel>();
    for (const [id, model] of classifyFurniture(config)) {
      const key = JSON.stringify(model);
      const kept = previous.current.get(id);
      const stable = kept && kept.key === key ? kept.model : model;
      next.set(id, { key, model: stable });
      models.set(id, stable);
    }
    previous.current = next;
    return models;
  }, [config]);
}
