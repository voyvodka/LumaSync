import { type RefObject, useMemo, useRef } from "react";

import type { RoomDropTarget } from "@/features/room-view/ui/RoomView3D";
import type { RoomCorner, RoomMapConfig } from "@/shared/contracts/roomMap";

import { type DropRect, dropRect, type LibraryCard, type LibraryDrop } from "../model/libraryDrop";
import { furnitureTile } from "../model/paletteTiles";
import { outsideOutline } from "../model/roomFootprint";
import type { PlanDropGhostHandle } from "../ui/drop/PlanDropGhost";
import { ROOM_MAP_VIEWPORT_ATTR } from "./useRoomMapViewport";

export const DROP_SURFACE_3D = '[data-testid="room-view-3d"]';
const STAGE = '[data-testid="room-map-stage"]';

export interface LibraryDropArgs {
  rootRef: RefObject<HTMLElement | null>;
  inRoom: boolean;
  config: RoomMapConfig;
  outline: readonly RoomCorner[];
  pxPerMeter: number;
  zoom: number;
  panOffset: { x: number; y: number };
  roomDropRef: RefObject<RoomDropTarget | null>;
  ghostRef: RefObject<PlanDropGhostHandle | null>;
  onAddFurniture: (type: Extract<LibraryCard, { kind: "furniture" }>["type"], at: { x: number; y: number }) => void;
  onAddTv: (at: { x: number; y: number }) => void;
  onLanded: () => void;
}

/** Nothing reaches the map, the history or the selection until the drop. */
export function useLibraryDrop(args: LibraryDropArgs): LibraryDrop {
  const latest = useRef(args);
  latest.current = args;

  return useMemo(() => {
    // The surface under the pointer, not merely the stage: the dock and the corner float over it.
    const surfaceAt = (clientX: number, clientY: number): HTMLElement | null => {
      const { rootRef, inRoom } = latest.current;
      const hit = document.elementFromPoint(clientX, clientY);
      const surface = hit?.closest<HTMLElement>(inRoom ? DROP_SURFACE_3D : `[${ROOM_MAP_VIEWPORT_ATTR}]`) ?? null;
      return surface && rootRef.current?.contains(surface) ? surface : null;
    };

    const rectAt = (card: LibraryCard, clientX: number, clientY: number): { rect: DropRect; surface: HTMLElement } | null => {
      const { inRoom, config, pxPerMeter, zoom, panOffset, roomDropRef } = latest.current;
      const surface = surfaceAt(clientX, clientY);
      if (!surface) return null;
      const room = { width: config.dimensions.widthMeters, depth: config.dimensions.depthMeters };
      if (inRoom) {
        const floor = roomDropRef.current?.floorAt(clientX, clientY);
        // The scene sits on the room's middle; the plan counts from its top-left corner.
        return floor ? { rect: dropRect(card, { x: floor.x + room.width / 2, y: floor.z + room.depth / 2 }, room), surface } : null;
      }
      const box = surface.getBoundingClientRect();
      const scale = pxPerMeter * zoom;
      return { rect: dropRect(card, { x: (clientX - box.left - panOffset.x) / scale, y: (clientY - box.top - panOffset.y) / scale }, room), surface };
    };

    const fits = (rect: DropRect) => !outsideOutline(rect.x + rect.width / 2, rect.y + rect.depth / 2, latest.current.outline);

    const clear = () => {
      latest.current.roomDropRef.current?.preview(null);
      latest.current.ghostRef.current?.show(null);
    };

    return {
      hover(card, clientX, clientY) {
        const at = rectAt(card, clientX, clientY);
        if (!at) {
          clear();
          return false;
        }
        const { rect, surface } = at;
        const valid = fits(rect);
        const { inRoom, roomDropRef, ghostRef, rootRef, pxPerMeter, zoom, panOffset } = latest.current;
        if (inRoom) {
          const tile = card.kind === "furniture" ? furnitureTile(card.type) : null;
          roomDropRef.current?.preview({
            piece: { id: "library-drop", type: tile?.type ?? "other", x: rect.x, y: rect.y, width: rect.width, height: rect.depth },
            model: tile?.model ?? null,
            valid,
          });
          return valid;
        }
        const stage = rootRef.current?.querySelector(STAGE)?.getBoundingClientRect();
        const box = surface.getBoundingClientRect();
        const scale = pxPerMeter * zoom;
        ghostRef.current?.show({
          card,
          left: box.left - (stage?.left ?? 0) + panOffset.x + rect.x * scale,
          top: box.top - (stage?.top ?? 0) + panOffset.y + rect.y * scale,
          width: rect.width * scale,
          height: rect.depth * scale,
          valid,
        });
        return valid;
      },
      land(card, clientX, clientY) {
        const at = rectAt(card, clientX, clientY);
        if (!at || !fits(at.rect)) {
          clear();
          return false;
        }
        latest.current.ghostRef.current?.show(null);
        latest.current.roomDropRef.current?.settle();
        const spot = { x: at.rect.x, y: at.rect.y };
        if (card.kind === "tv") latest.current.onAddTv(spot);
        else latest.current.onAddFurniture(card.type, spot);
        latest.current.onLanded();
        return true;
      },
      cancel: clear,
    };
  }, []);
}
