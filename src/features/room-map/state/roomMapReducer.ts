import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { parseObjectId } from "../model/objectId";

export const MAX_HISTORY = 50;

/** How long a gesture key stays open. Long enough to span the gap between a
 *  key press and its first auto-repeat, short enough that two deliberate
 *  presses a beat apart stay two undo steps. */
export const GESTURE_COALESCE_MS = 600;

export type RoomMapPatch =
  | Partial<RoomMapConfig>
  | ((config: RoomMapConfig) => Partial<RoomMapConfig>);

export interface RoomMapSelection {
  objectId: string | null;
  hueZoneId: string | null;
}

export interface RoomMapGesture {
  key: string;
  at: number;
}

export interface RoomMapState {
  config: RoomMapConfig;
  past: RoomMapConfig[];
  future: RoomMapConfig[];
  selection: RoomMapSelection;
  /** The coalescing gesture still open, or `null` once anything else lands. */
  gesture: RoomMapGesture | null;
  /** Bumped by every change that has to reach disk. */
  saveSeq: number;
  /** The last change belongs to an open gesture: save once it goes quiet. */
  saveDeferred: boolean;
}

export type RoomMapAction =
  | { type: "hydrate"; config: RoomMapConfig }
  | {
      type: "apply";
      patch: RoomMapPatch;
      /** Replace the whole config instead of merging top-level keys. */
      replace?: boolean;
      gesture?: RoomMapGesture & {
        /** An auto-repeat of the same key: joins the open gesture however long
         *  the OS waited before repeating. */
        continued?: boolean;
      };
    }
  | { type: "adopt"; patch: RoomMapPatch }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; objectId: string | null }
  | { type: "selectHueZone"; hueZoneId: string | null };

export function initialRoomMapState(): RoomMapState {
  return {
    config: DEFAULT_ROOM_MAP,
    past: [],
    future: [],
    selection: { objectId: null, hueZoneId: null },
    gesture: null,
    saveSeq: 0,
    saveDeferred: false,
  };
}

function resolvePatch(patch: RoomMapPatch, config: RoomMapConfig): Partial<RoomMapConfig> {
  return typeof patch === "function" ? patch(config) : patch;
}

function objectExists(config: RoomMapConfig, objectId: string): boolean {
  const parsed = parseObjectId(objectId);
  switch (parsed?.kind) {
    case "tv":
      return config.tvAnchor !== undefined;
    case "furniture":
      return config.furniture.some((f) => f.id === parsed.furnitureId);
    case "usb":
      return config.usbStrips.some((s) => s.stripId === parsed.stripId);
    case "hue":
      return config.hueChannels.some((c) => c.channelIndex === parsed.channelIndex);
    case "image":
      return config.imageLayers.some((l) => l.id === parsed.layerId);
    default:
      return false;
  }
}

/** Undo can take away the very object that is selected; a selection pointing
 *  at nothing would leave the inspector and the property bar dangling. */
function reconcileSelection(config: RoomMapConfig, selection: RoomMapSelection): RoomMapSelection {
  const objectId =
    selection.objectId !== null && objectExists(config, selection.objectId) ? selection.objectId : null;
  const hueZoneId =
    selection.hueZoneId !== null && config.zones.some((z) => z.id === selection.hueZoneId)
      ? selection.hueZoneId
      : null;
  if (objectId === selection.objectId && hueZoneId === selection.hueZoneId) return selection;
  return { objectId, hueZoneId };
}

function pushBounded(stack: RoomMapConfig[], entry: RoomMapConfig): RoomMapConfig[] {
  return [...stack.slice(-(MAX_HISTORY - 1)), entry];
}

function joinsOpenGesture(
  open: RoomMapGesture | null,
  next: NonNullable<Extract<RoomMapAction, { type: "apply" }>["gesture"]>,
): boolean {
  if (!open || open.key !== next.key) return false;
  return next.continued === true || next.at - open.at <= GESTURE_COALESCE_MS;
}

export function roomMapReducer(state: RoomMapState, action: RoomMapAction): RoomMapState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        config: action.config,
        past: [],
        future: [],
        gesture: null,
        selection: reconcileSelection(action.config, state.selection),
      };
    case "apply": {
      const partial = resolvePatch(action.patch, state.config);
      const config = action.replace
        ? (partial as RoomMapConfig)
        : { ...state.config, ...partial };
      const merges = action.gesture !== undefined && joinsOpenGesture(state.gesture, action.gesture);
      return {
        config,
        past: merges ? state.past : pushBounded(state.past, state.config),
        future: [],
        selection: reconcileSelection(config, state.selection),
        gesture: action.gesture ? { key: action.gesture.key, at: action.gesture.at } : null,
        saveSeq: state.saveSeq + 1,
        saveDeferred: action.gesture !== undefined,
      };
    }
    // A write the user did not make — reconciling against the bridge, say. It
    // skips history on purpose: an undo entry the user cannot account for is
    // worse than none, and Cmd+Z would silently undo the reconciliation.
    case "adopt": {
      const config = { ...state.config, ...resolvePatch(action.patch, state.config) };
      return {
        ...state,
        config,
        selection: reconcileSelection(config, state.selection),
        gesture: null,
        saveSeq: state.saveSeq + 1,
        saveDeferred: false,
      };
    }
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        config: previous,
        past: state.past.slice(0, -1),
        future: [...state.future, state.config],
        selection: reconcileSelection(previous, state.selection),
        gesture: null,
        saveSeq: state.saveSeq + 1,
        saveDeferred: false,
      };
    }
    case "redo": {
      const next = state.future[state.future.length - 1];
      if (next === undefined) return state;
      return {
        config: next,
        past: pushBounded(state.past, state.config),
        future: state.future.slice(0, -1),
        selection: reconcileSelection(next, state.selection),
        gesture: null,
        saveSeq: state.saveSeq + 1,
        saveDeferred: false,
      };
    }
    case "select":
      if (state.selection.objectId === action.objectId) return state;
      return { ...state, selection: { ...state.selection, objectId: action.objectId } };
    // Exclusive with an object: the inspector and the side list must never
    // disagree about what is selected.
    case "selectHueZone": {
      const objectId = action.hueZoneId !== null ? null : state.selection.objectId;
      if (state.selection.hueZoneId === action.hueZoneId && state.selection.objectId === objectId) {
        return state;
      }
      return { ...state, selection: { objectId, hueZoneId: action.hueZoneId } };
    }
  }
}
