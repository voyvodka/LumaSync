import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { type FurnitureModel, modelTop } from "@/features/room-view/model/furnitureModel";
import type { LampFamily } from "@/features/room-view/model/lampFamily";
import { hueFacings } from "../model/hueFacing";
import { seatMovedLight } from "../model/lightSeat";
import { ROOM_VIEW_3D_AVAILABLE, RoomView3DHost } from "@/features/room-view/ui/RoomView3DHost";
import type { CameraCommand } from "@/features/room-view/ui/RoomView3D";
import { roomMood } from "@/features/room-view/model/roomMood";
import { useRunningLightingMode } from "@/features/mode/state/lightingControl";
import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZoneStatusCode,
  RoomDimensions,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import {
  replaceHueChannel,
  stripCentre,
  translateStrip,
  resolveRoomFootprint,
  ROOM_MAP_BACKGROUND_ERROR,
  ROOM_MAP_BACKGROUND_MAX_MB,
} from "@/shared/contracts/roomMap";
import { isEditableTarget } from "@/shared/lib/editableTarget";
import { Callout } from "@/shared/ui/Callout/Callout";

import { deriveHueAreaState } from "../model/hueAreaState";
import { setHueChannelWorldZ } from "../model/hueChannelPosition";
import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  parseObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
} from "../model/objectId";
import type { RoomAwareStatus } from "../model/roomAware";
import { roomObjectAdapter } from "../model/roomObjectKinds";
import { useFurnitureModels } from "../state/useFurnitureModels";
import { useLandCarried } from "../state/useLandCarried";
import type { RoomMapDocument } from "../state/useRoomMapDocument";
import { useRoomMapGridSettings } from "../state/useRoomMapGridSettings";
import { useUsbStripStatus } from "../state/useUsbStripStatus";
import { FootprintWalls } from "./objects/FootprintWalls";
import {
  buildFootprint,
  describeFootprint,
  type FootprintShape,
  footprintMinimumSize,
  outsideOutline,
  resizeFootprint,
  type FootprintSide,
} from "../model/roomFootprint";
import { isBacklightStrip, moveTvWithBacklight } from "../model/backlight";
import { keepPlacedInside, keepStripInside, roomBoxOf, snapToStep } from "../model/pieceGeometry";
import { refitRetapedStrip } from "../model/stripFit";
import { resizeRoomFromSide } from "../model/roomResize";
import { useRoomMapHueZones } from "../state/useRoomMapHueZones";
import { imageLayerGestureKey, useRoomMapImageLayers } from "../state/useRoomMapImageLayers";
import { useRoomMapObjects } from "../state/useRoomMapObjects";
import { ROOM_MAP_PX_PER_METER, ROOM_MAP_VIEWPORT_ATTR, useRoomMapViewport } from "../state/useRoomMapViewport";
import { useSnapGuides } from "../state/useSnapGuides";
import { ContextMenu, type ContextMenuAction } from "./ContextMenu";
import { CornerControls, EDIT_STAGES, type EditStage } from "./CornerControls";
import { ROOM_MAP_FIT_INSETS } from "./dock/dockGeometry";
import type { InspectorActions } from "./dock/DockInspector";
import { RoomDock } from "./dock/RoomDock";
import { HueChannelOverlay } from "./HueChannelOverlay";
import { FurnitureObject } from "./objects/FurnitureObject";
import { TvAnchorObject } from "./objects/TvAnchorObject";
import { UsbStripObject } from "./objects/UsbStripObject";
import { OriginMarker } from "./OriginMarker";
import { RoomMapCanvas } from "./RoomMapCanvas";
import styles from "./RoomMapEditor.module.css";
import { SnapGuideOverlay } from "./SnapGuideOverlay";

const NO_FAMILIES: ReadonlyMap<number, LampFamily> = new Map();

export interface RoomMapEditorProps {
  /** The map, its history and its Hue area, owned by the surface so they outlive this face. */
  doc: RoomMapDocument;
  /** Opens Devices, where a bridge is paired, an area picked and a strip managed. */
  onNavigateToDevices?: () => void;
  /** App-level Hue reachability; `undefined` (an embed with no source of truth) shows no state. */
  hueReachable?: boolean;
  /** The room-aware chip's state; `null` hides it. */
  roomAware?: RoomAwareStatus | null;
  /** Take the keys on mount: the face opened from a control the switch just took away. */
  focusOnMount?: boolean;
  /** Each Hue channel's fixture as the bridge names it, for the inspector's model choice. */
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  /** Opens the template picker over the room. */
  onTemplates?: () => void;
  /** Whether the room can be edited in 3D; a WebGL failure reports through `onRoomFail`. */
  room3d?: boolean;
  onRoomFail?: (error: unknown) => void;
}

// What the editor drew the room as last, for the session: Edit opens on it again. Not stored —
// opening on the room the first time is the point.
let lastStage: EditStage = EDIT_STAGES.ROOM;

/** Test seam — the next editor opens on the 3D room again. */
export function __resetEditStage(): void {
  lastStage = EDIT_STAGES.ROOM;
}

const IS_MAC = navigator.platform.includes("Mac");
const BOX_MODEL: FurnitureModel = { kind: "box" };

// Literal keys, not `\`…${code}\``, so the orphan ratchet can see each one.
const HUE_ZONE_REJECTION_KEYS = {
  HUE_ZONE_CREATED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_UPDATED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_DELETED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_NOT_FOUND: "roomMap:hueZones.rejected.notFound",
  HUE_ZONE_CHANNEL_OUT_OF_BOUNDS: "roomMap:hueZones.rejected.outOfBounds",
  HUE_ZONE_LIMIT_REACHED: "roomMap:hueZones.rejected.limitReached",
  HUE_ZONE_CHANNEL_NOT_IN_AREA: "roomMap:hueZones.rejected.notInArea",
  HUE_ZONE_OVERSIZED: "roomMap:hueZones.rejected.oversized",
} as const satisfies Record<HueZoneStatusCode, string>;

function isCanvasKey(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.target === e.currentTarget) return true;
  return e.target instanceof Element && e.target.closest(`[${ROOM_MAP_VIEWPORT_ATTR}]`) !== null;
}

export function RoomMapEditor({
  doc,
  onNavigateToDevices,
  hueReachable,
  roomAware = null,
  focusOnMount = false,
  lampFamilies = NO_FAMILIES,
  onTemplates,
  room3d = false,
  onRoomFail,
}: RoomMapEditorProps) {
  const { t } = useTranslation();
  const {
    config,
    selectedId,
    activeHueZoneId,
    apply,
    adopt,
    reset,
    undo,
    redo,
    select,
    selectHueZone,
    clearSelection,
    canUndo,
    canRedo,
    error,
    retrySave,
    hueAreaId,
    hueBridgeConfigured,
    visibleHueChannels,
    scopedConfig,
  } = doc;
  const { areaChannels, channelsStatus, isLoadingChannels, liveChannelIds, refreshChannels } = doc.hue;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);
  const [stage, setStageState] = useState<EditStage>(room3d ? lastStage : EDIT_STAGES.PLAN);
  // The stage the editor opens on is there at once; only a switch fades one in.
  const [stageSwitched, setStageSwitched] = useState(false);
  const setStage = useCallback((next: EditStage) => {
    lastStage = next;
    setStageState(next);
    setStageSwitched(true);
  }, []);
  const inRoom = room3d && stage === EDIT_STAGES.ROOM;
  // An image layer and a Hue zone are drawn on the plan alone: a card for one opens the plan with it.
  const planFor = useCallback(
    (objectId: string | null) => {
      if (room3d && objectId !== null && parseObjectId(objectId)?.kind === "image") setStage(EDIT_STAGES.PLAN);
    },
    [room3d, setStage],
  );
  const selectShowingPlan = useCallback(
    (objectId: string | null) => {
      planFor(objectId);
      select(objectId);
    },
    [planFor, select],
  );
  // The other way, the card of something the room does not draw closes with the plan.
  const changeStage = useCallback(
    (next: EditStage) => {
      if (next === EDIT_STAGES.ROOM) {
        if (activeHueZoneId !== null) selectHueZone(null);
        if (selectedId !== null && parseObjectId(selectedId)?.kind === "image") select(null);
      }
      setStage(next);
    },
    [activeHueZoneId, selectedId, select, selectHueZone, setStage],
  );
  const selectZoneShowingPlan = useCallback(
    (zoneId: string | null) => {
      if (room3d && zoneId !== null) setStage(EDIT_STAGES.PLAN);
      selectHueZone(zoneId);
    },
    [room3d, setStage, selectHueZone],
  );
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | undefined>(undefined);
  const running = useRunningLightingMode();
  const mood = useMemo(() => roomMood(running), [running]);
  const landCarriedPiece = useLandCarried(doc);

  const { showGrid, setShowGrid, gridStrokeWidth, setGridStrokeWidth, showHueZones, setShowHueZones } = useRoomMapGridSettings();

  const {
    hueZones,
    activeHueZone,
    hueZoneRejection,
    dismissHueZoneRejection,
    handleAddHueZone,
    handleDeleteHueZone,
    handleRenameHueZone,
    handleAssignChannelToZone,
    handleHueZoneCenterChange,
    handleHueZoneUpdate,
  } = useRoomMapHueZones({
    config,
    apply,
    adopt,
    activeHueZoneId,
    selectHueZone,
    hueAreaId,
  });
  // Memoised: the overlay is, and a fresh map each render redrew every dot through a pan.
  const facings = useMemo(
    () => (ROOM_VIEW_3D_AVAILABLE ? hueFacings(visibleHueChannels, config, lampFamilies) : undefined),
    [visibleHueChannels, config, lampFamilies],
  );
  // The zones a light of the shown area can join: another area's zone holds another area's lights.
  const areaZones = useMemo(
    () => (hueAreaId ? hueZones.filter((zone) => zone.entertainmentAreaId === hueAreaId) : hueZones),
    [hueZones, hueAreaId],
  );

  const { guides: snapGuides, dragging: pieceDragging, onDragMove: snapDragMove, onDragEnd: snapDragEnd } = useSnapGuides(config);
  const furnitureModels = useFurnitureModels(config);
  // Drawn lowest first, as seen from above: a rug stays under the sofa on it, whatever was added last.
  const furnitureByHeight = useMemo(() => {
    const top = (f: (typeof config.furniture)[number]) => f.topMeters ?? modelTop(furnitureModels.get(f.id) ?? BOX_MODEL);
    return config.furniture
      .map((f, index) => ({ f, index, top: top(f) }))
      .sort((a, b) => a.top - b.top || a.index - b.index)
      .map(({ f }) => f);
  }, [config.furniture, furnitureModels]);

  const { setCanvasContainer, canvasSize, zoom, setZoom, panOffset, setPanOffset, spaceHeld, fitToView, handleArrowPan } =
    useRoomMapViewport(config.dimensions, ROOM_MAP_FIT_INSETS);

  const { stripStatus, hueBridgeStatus } = useUsbStripStatus(hueReachable);

  const {
    handleAddTv,
    handleAddFurniture,
    handleAddUsb,
    deleteById,
    handleDelete,
    handleRotate,
    handleDuplicate,
    handleArrowNudge,
    handleUpdatePosition,
    handleRename,
  } = useRoomMapObjects({ config, hueAreaId, apply, selectedId, select });

  const { handleAddImage, imageError, imageErrorCode } = useRoomMapImageLayers({ apply, select: selectShowingPlan });

  const { widthMeters, depthMeters } = config.dimensions;
  // One object per size, so the memoised TV and strips do not redraw on every editor render.
  const roomBox = useMemo(() => ({ width: widthMeters, depth: depthMeters }), [widthMeters, depthMeters]);

  const pxPerMeter = ROOM_MAP_PX_PER_METER;
  const gridStepM = widthMeters < 4 ? 0.5 : 1.0;
  const gridStepPx = gridStepM * pxPerMeter;

  const focusEditor = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    if (focusOnMount) focusEditor();
  }, []);
  // A pick from the list leaves the zone: a zone kept active dims every light outside it.
  const selectFromList = useCallback(
    (id: string) => {
      planFor(id);
      select(id);
      selectHueZone(null);
    },
    [planFor, select, selectHueZone],
  );
  // One step back: an object to the zone it was picked over, a zone to the palette.
  const popSelection = useCallback(() => {
    if (selectedId !== null) select(null);
    else if (activeHueZoneId !== null) selectHueZone(null);
  }, [selectedId, activeHueZoneId, select, selectHueZone]);

  // Canvas objects are memoised, so every callback they receive has to be
  // stable: an inline closure would re-render all of them on a pan commit.
  // Empty ground lets go of both: `select(null)` alone left a zone selected under the palette.
  const handleCanvasClick = clearSelection;
  // A pick in the 3D room is a pick from the list; OrbitControls takes the press, so the root is
  // focused here for the editor's keys (Delete, ⌘Z, the arrows) to reach it.
  const handleRoomPick = useCallback(
    (objectId: string | null) => {
      if (objectId) selectFromList(objectId);
      else clearSelection();
      focusEditor();
    },
    [selectFromList, clearSelection, focusEditor],
  );
  const handleUsbStripChange = useCallback(
    (updated: UsbStripPlacement, continuous?: boolean) => {
      apply(
        (cfg) => ({
          // A new LED count on tape of a known density is a new length.
          usbStrips: cfg.usbStrips.map((s) =>
            s.stripId !== updated.stripId ? s : keepStripInside(refitRetapedStrip(s, updated, cfg), roomBoxOf(cfg)),
          ),
        }),
        continuous ? { gesture: `usb:${updated.stripId}:ledCount` } : undefined,
      );
    },
    [apply],
  );
  // Several objects at once — furniture, the TV, Hue lights, strips: ⇧-click adds or takes one away,
  // a box on the floor takes what it covers. The one last pressed is what the inspector shows;
  // dragging a piece or the TV moves them all, so a desk carries its monitor and its lamps.
  const [group, setGroup] = useState<readonly string[]>([]);
  const groupSet = useMemo(() => new Set(group), [group]);
  // Read before scheduling a reset, so a plain click with no group schedules no update at all.
  const groupRef = useRef(group);
  groupRef.current = group;
  const clearGroup = useCallback(() => {
    if (groupRef.current.length > 0) setGroup([]);
  }, []);
  const grouped = group.length > 1;
  const shiftHeld = useRef(false);
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      shiftHeld.current = e.shiftKey;
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
    };
  }, []);
  useEffect(() => {
    if (selectedId === null || (grouped && !groupSet.has(selectedId))) clearGroup();
  }, [selectedId, grouped, groupSet, clearGroup]);
  const pick = useCallback(
    (objectId: string, additive: boolean) => {
      if (additive) {
        setGroup((current) => {
          const base = current.length > 0 ? current : selectedId && selectedId !== objectId ? [selectedId] : [];
          return base.includes(objectId) ? base.filter((member) => member !== objectId) : [...base, objectId];
        });
      } else if (!groupSet.has(objectId)) {
        clearGroup();
      }
      select(objectId);
    },
    [select, selectedId, groupSet, clearGroup],
  );
  const handleFurnitureSelect = useCallback(
    (id: string, additive = false) => pick(furnitureObjectId(id), additive || shiftHeld.current),
    [pick],
  );
  const handleMarquee = useCallback(
    (box: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => {
      const within = (x: number, y: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
      const inside = [
        ...config.furniture.filter((f) => within(f.x + f.width / 2, f.y + f.height / 2)).map((f) => furnitureObjectId(f.id)),
        ...(config.tvAnchor && within(config.tvAnchor.x + config.tvAnchor.width / 2, config.tvAnchor.y + config.tvAnchor.height / 2)
          ? [TV_ANCHOR_OBJECT_ID]
          : []),
        ...visibleHueChannels
          .filter((ch) => within(((ch.x + 1) / 2) * widthMeters, ((1 - ch.y) / 2) * depthMeters))
          .map((ch) => hueChannelObjectId(ch.channelIndex)),
        ...config.usbStrips
          .filter((st) => {
            const centre = stripCentre(st);
            return within(centre.x, centre.y);
          })
          .map((st) => usbStripObjectId(st.stripId)),
      ];
      const next = additive ? [...new Set([...group, ...inside])] : inside;
      setGroup(next);
      select(next[next.length - 1] ?? null);
    },
    [config.furniture, config.tvAnchor, config.usbStrips, visibleHueChannels, widthMeters, depthMeters, group, select],
  );
  // Followers move with the drag by a CSS `translate` on their own element, which composes with
  // their placement and rotation and costs no render per move; the drop writes them all at once.
  const followers = useCallback(
    (except: string) =>
      group
        .filter((id) => id !== except)
        .map((id) => rootRef.current?.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(id)}"]`))
        .filter((el): el is HTMLElement => !!el),
    [group],
  );
  const handleGroupDragMove = useCallback(
    (dragger: string, dx: number, dy: number) => {
      for (const el of followers(dragger)) el.style.translate = `${dx * pxPerMeter}px ${dy * pxPerMeter}px`;
    },
    [followers],
  );
  const handleGroupDragEnd = useCallback(
    (dragger: string, dx: number, dy: number) => {
      for (const el of followers(dragger)) el.style.translate = "";
      if (dx === 0 && dy === 0) return;
      const round = (v: number) => Math.round(v * 100) / 100;
      const clampCube = (v: number) => Math.min(1, Math.max(-1, v));
      apply((cfg) => {
        let hueChannels = cfg.hueChannels;
        for (const ch of visibleHueChannels) {
          if (!groupSet.has(hueChannelObjectId(ch.channelIndex)) || ch.locked) continue;
          hueChannels = replaceHueChannel(hueChannels, {
            ...ch,
            x: clampCube(ch.x + (2 * dx) / widthMeters),
            y: clampCube(ch.y - (2 * dy) / depthMeters),
          });
        }
        const tv = cfg.tvAnchor;
        return {
          furniture: cfg.furniture.map((f) =>
            groupSet.has(furnitureObjectId(f.id)) && !f.locked ? { ...f, x: round(f.x + dx), y: round(f.y + dy) } : f,
          ),
          ...(tv && groupSet.has(TV_ANCHOR_OBJECT_ID) && !tv.locked ? { tvAnchor: { ...tv, x: round(tv.x + dx), y: round(tv.y + dy) } } : {}),
          usbStrips: cfg.usbStrips.map((st) =>
            groupSet.has(usbStripObjectId(st.stripId)) && !st.locked
              ? translateStrip(st, dx, dy)
              : st,
          ),
          hueChannels,
        };
      });
    },
    [apply, followers, groupSet, visibleHueChannels, widthMeters, depthMeters],
  );
  const handleDeleteSelection = useCallback(() => {
    if (!grouped) {
      handleDelete();
      return;
    }
    // One patch folded over every member: removing them one by one wrote each from the same stale
    // map, so only the last removal stuck. Hue lights are the bridge's and are only deselected.
    apply((cfg) => {
      let next = cfg;
      for (const id of group) {
        const ref = parseObjectId(id);
        const adapter = ref ? roomObjectAdapter(ref) : null;
        if (!ref || !adapter?.remove || adapter.isLocked(next, ref, { hueAreaId })) continue;
        next = { ...next, ...adapter.remove(next, ref) };
      }
      return { furniture: next.furniture, usbStrips: next.usbStrips, tvAnchor: next.tvAnchor, imageLayers: next.imageLayers };
    });
    setGroup([]);
    select(null);
  }, [grouped, group, handleDelete, apply, hueAreaId, select]);
  const handleFurnitureChange = useCallback(
    (updated: FurniturePlacement) => {
      apply((cfg) => ({
        furniture: cfg.furniture.map((item) => (item.id === updated.id ? updated : item)),
      }));
    },
    [apply],
  );
  const handleUsbStripSelect = useCallback((id: string) => pick(usbStripObjectId(id), shiftHeld.current), [pick]);
  const handleTvSelect = useCallback(() => pick(TV_ANCHOR_OBJECT_ID, shiftHeld.current), [pick]);
  const handleTvChange = useCallback(
    (updated: TvAnchorPlacement) => {
      const room = roomBoxOf(config);
      const tvAnchor = keepPlacedInside(updated, room);
      const strips = config.tvAnchor
        ? moveTvWithBacklight(config.usbStrips, config.tvAnchor, tvAnchor, (s) => keepStripInside(s, room))
        : null;
      apply(strips ? { tvAnchor, usbStrips: strips } : { tvAnchor });
    },
    [apply, config],
  );
  const handleHueChannelSelect = useCallback(
    (channelIndex: number) => pick(hueChannelObjectId(channelIndex), shiftHeld.current),
    [pick],
  );
  const handleHueChannelChange = useCallback(
    (updated: HueChannelPlacement) => {
      apply((cfg) => {
        const before = cfg.hueChannels.find(
          (ch) => ch.channelIndex === updated.channelIndex && (ch.entertainmentAreaId ?? "") === (updated.entertainmentAreaId ?? ""),
        );
        return { hueChannels: replaceHueChannel(cfg.hueChannels, before ? seatMovedLight(before, updated, cfg) : updated) };
      });
    },
    [apply],
  );
  const handleImageLayerSelect = useCallback((id: string) => select(imageLayerObjectId(id)), [select]);
  const handleImageLayerTransformChange = useCallback(
    (id: string, offsetX: number, offsetY: number, scale: number, scaleX?: number, scaleY?: number, continuous?: boolean) => {
      apply(
        (cfg) => ({
          imageLayers: cfg.imageLayers.map((l) =>
            l.id === id
              ? {
                  ...l,
                  offsetX,
                  offsetY,
                  scale,
                  ...(scaleX != null ? { scaleX } : {}),
                  ...(scaleY != null ? { scaleY } : {}),
                }
              : l,
          ),
        }),
        continuous ? { gesture: imageLayerGestureKey(id, "scale") } : undefined,
      );
    },
    [apply],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // A field's keys are the field's: Backspace in the LED count deleted the
      // strip, and Cmd+Z replaced the field's own undo with the editor's.
      if (isEditableTarget(e.target)) return;
      // Matched on the physical key: with ⇧ the key is "Z", and on a Turkish layout ⌥ changes it.
      // Undo: Cmd+Z (Mac) / Ctrl+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      // Redo: Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      // Fit to view: Cmd+0 (Mac) / Ctrl+0 (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && (e.code === "Digit0" || e.code === "Numpad0")) {
        e.preventDefault();
        if (inRoom) setCameraCommand((c) => ({ kind: "reset", seq: (c?.seq ?? 0) + 1 }));
        else fitToView(16);
        return;
      }
      // Duplicate: Cmd+D (Mac) / Ctrl+D (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyD") {
        e.preventDefault();
        if (selectedId) handleDuplicate(selectedId);
        return;
      }
      // Bare keys are the canvas's. On a dock tile, a segmented control or a menu
      // item an arrow moved the selection along with the control, and Delete
      // removed the selected object.
      if (!isCanvasKey(e)) return;
      if (e.key === "Escape") {
        popSelection();
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDeleteSelection();
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        handleRotate();
      } else if (selectedId) {
        handleArrowNudge(e);
      } else if (!inRoom) {
        // Arrows were a dead key with nothing selected, which left keyboard-only
        // users no way to move the viewport at all.
        handleArrowPan(e);
      }
    },
    [handleDeleteSelection, handleRotate, handleArrowNudge, handleArrowPan, handleDuplicate, undo, redo, popSelection, selectedId, fitToView, inRoom],
  );

  /** Everything in the room moved by (`dxM`, `dyM`) metres, as a patch. Hue channels and zones live
   *  in the bridge's [-1, 1] cube, which spans the room, so they follow its size without a shift. */
  const shiftedContents = useCallback(
    (from: typeof config, dxM: number, dyM: number): Partial<typeof config> => {
      const patch: Partial<typeof config> = {};
      if (from.tvAnchor) patch.tvAnchor = { ...from.tvAnchor, x: from.tvAnchor.x + dxM, y: from.tvAnchor.y + dyM };
      if (from.furniture.length > 0) patch.furniture = from.furniture.map((f) => ({ ...f, x: f.x + dxM, y: f.y + dyM }));
      if (from.usbStrips.length > 0) {
        patch.usbStrips = from.usbStrips.map((s) => translateStrip(s, dxM, dyM));
      }
      if (from.imageLayers.length > 0) {
        patch.imageLayers = from.imageLayers.map((l) => ({ ...l, offsetX: l.offsetX + dxM * pxPerMeter, offsetY: l.offsetY + dyM * pxPerMeter }));
      }
      return patch;
    },
    [],
  );

  // An outer wall dragged: the opposite wall and everything in the room stay where they are on screen.
  const wallDragStart = useRef<{ config: typeof config; pan: { x: number; y: number } } | null>(null);
  const handleWallResizeStart = useCallback(() => {
    wallDragStart.current = { config, pan: panOffset };
  }, [config, panOffset]);
  const handleWallResize = useCallback(
    (side: FootprintSide, delta: number, gesture: string) => {
      const start = wallDragStart.current;
      if (!start) return;
      const next = resizeRoomFromSide(start.config.dimensions, start.config.footprint, side, snapToStep(delta, 0.05));
      if (!next) return;
      setPanOffset({
        x: start.pan.x - next.shift.x * pxPerMeter * zoom,
        y: start.pan.y - next.shift.y * pxPerMeter * zoom,
      });
      apply(
        { dimensions: next.dimensions, footprint: next.footprint, ...shiftedContents(start.config, next.shift.x, next.shift.y) },
        { gesture },
      );
    },
    [apply, zoom, setPanOffset, shiftedContents],
  );

  const handleDimensionsChange = useCallback(
    (d: RoomDimensions) => {
      // Keep room center fixed on screen when resizing (pxPerMeter is constant)
      const oldCenterScreenX = panOffset.x + (widthMeters / 2) * pxPerMeter * zoom;
      const oldCenterScreenY = panOffset.y + (depthMeters / 2) * pxPerMeter * zoom;

      const newPanX = oldCenterScreenX - (d.widthMeters / 2) * pxPerMeter * zoom;
      const newPanY = oldCenterScreenY - (d.depthMeters / 2) * pxPerMeter * zoom;
      setPanOffset({ x: newPanX, y: newPanY });

      // Shift all objects so they keep their position relative to room center
      const dxM = (d.widthMeters - widthMeters) / 2;
      const dyM = (d.depthMeters - depthMeters) / 2;

      const patch: Partial<typeof config> = { dimensions: d, ...shiftedContents(config, dxM, dyM) };
      // A height-only change leaves the outline as it is stored.
      if (config.footprint !== undefined && (d.widthMeters !== widthMeters || d.depthMeters !== depthMeters)) {
        patch.footprint = resizeFootprint(config.footprint, config.dimensions, d);
      }

      apply(patch);
    },
    [apply, config, panOffset, widthMeters, depthMeters, zoom, setPanOffset, shiftedContents],
  );

  const outline = useMemo(
    () => resolveRoomFootprint({ dimensions: config.dimensions, footprint: config.footprint }),
    [config.dimensions, config.footprint],
  );
  const roomShape = useMemo(() => describeFootprint(config.footprint, config.dimensions), [config.footprint, config.dimensions]);
  const minimumSize = useMemo(() => footprintMinimumSize(config.footprint, config.dimensions), [config.footprint, config.dimensions]);
  const handleShapeChange = useCallback(
    (shape: FootprintShape) => apply({ footprint: buildFootprint(shape, config.dimensions) }),
    [apply, config.dimensions],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // A right-click in a popover reaches here through the React tree from its portal; only the
      // plan has a menu.
      if (!(e.target instanceof Element) || e.target.closest(`[${ROOM_MAP_VIEWPORT_ATTR}]`) === null) return;
      e.preventDefault();
      if (!selectedId) return;
      setContextMenu({ x: e.clientX, y: e.clientY, targetId: selectedId });
    },
    [selectedId],
  );

  const getContextMenuActions = useCallback((): ContextMenuAction[] => {
    if (!contextMenu) return [];
    const id = contextMenu.targetId;
    const actions: ContextMenuAction[] = [];

    const parsed = parseObjectId(id);
    const adapter = parsed ? roomObjectAdapter(parsed) : null;
    if (adapter?.duplicate) {
      actions.push({
        label: t("roomMap:contextMenu.duplicate"),
        shortcut: IS_MAC ? "⌘D" : "Ctrl+D",
        onClick: () => handleDuplicate(id),
      });
    }

    if (adapter?.rotateBy) {
      actions.push({
        label: t("roomMap:contextMenu.rotate"),
        shortcut: "R",
        onClick: () => {
          select(id);
          handleRotate();
        },
      });
    }

    if (adapter?.remove) {
      actions.push({
        label: t("roomMap:contextMenu.delete"),
        shortcut: IS_MAC ? "⌫" : t("roomMap:shortcuts.keys.del"),
        danger: true,
        onClick: () => deleteById(id),
      });
    }

    return actions;
  }, [contextMenu, t, handleDuplicate, handleRotate, deleteById, select]);

  // Inline closures on purpose: the dock is not memoised, and every one of these reads the
  // config as it is now.
  const inspectorActions: InspectorActions = {
    // A chip or swatch group selects on every arrow key; the gesture keeps a run of them one
    // undo step and one save, as the zone inspector's fields do.
    onUpdateTvAnchor: (patch) => {
      if (!config.tvAnchor) return;
      apply({ tvAnchor: keepPlacedInside({ ...config.tvAnchor, ...patch }, roomBoxOf(config)) }, { gesture: `tv:${Object.keys(patch).sort().join(",")}` });
    },
    onUpdateFurniture: (id, patch) => {
      apply(
        { furniture: config.furniture.map((f) => (f.id === id ? keepPlacedInside({ ...f, ...patch }, roomBoxOf(config)) : f)) },
        { gesture: `furniture:${id}:${Object.keys(patch).sort().join(",")}` },
      );
    },
    onUpdateUsbStrip: (stripId, patch) => {
      apply({
        usbStrips: config.usbStrips.map((s) => {
          if (s.stripId !== stripId) return s;
          const next = { ...s, ...patch };
          return keepStripInside(refitRetapedStrip(s, next, config), roomBoxOf(config));
        }),
      });
    },
    onUpdateImageLayer: (id, patch) => {
      // The opacity slider lands here per input event.
      apply(
        { imageLayers: config.imageLayers.map((l) => (l.id === id ? { ...l, ...patch } : l)) },
        { gesture: imageLayerGestureKey(id, Object.keys(patch).sort().join(",")) },
      );
    },
    // A held arrow in X or Y steps many times; the gesture keeps it one undo step and one save.
    onMoveObject: (id, x, y) => handleUpdatePosition(id, x, y, { gesture: `move:${id}` }),
    onUpdateHueChannel: (channelIndex, patch) => {
      // The shown area's channel: the same index names another light in every other area.
      const target = visibleHueChannels.find((ch) => ch.channelIndex === channelIndex);
      if (!target) return;
      apply(
        { hueChannels: replaceHueChannel(config.hueChannels, { ...target, ...patch }) },
        { gesture: `hue:${channelIndex}:${Object.keys(patch).sort().join(",")}` },
      );
    },
    onHueChannelHeightChange: (channelIndex, worldZ) => {
      const target = visibleHueChannels.find((ch) => ch.channelIndex === channelIndex);
      if (!target) return;
      // A slider, like the opacity one.
      apply(
        { hueChannels: replaceHueChannel(config.hueChannels, setHueChannelWorldZ(target, config.zones, worldZ)) },
        { gesture: `hue-height:${channelIndex}` },
      );
    },
    onRename: handleRename,
    onToggleLock: (id) => {
      const ref = parseObjectId(id);
      const patch = ref ? roomObjectAdapter(ref).toggleLock(config, ref, visibleHueChannels) : null;
      if (patch) apply(patch);
    },
    onDuplicate: handleDuplicate,
    onDelete: deleteById,
    onUpdateHueZone: handleHueZoneUpdate,
    onRenameHueZone: handleRenameHueZone,
    onDeleteHueZone: handleDeleteHueZone,
    onAssignChannelToZone: handleAssignChannelToZone,
    // Deep-links to Devices: no window may call `disconnect_serial_port` until the Devices page
    // carries a strip's Disconnect.
    onManageUsb: onNavigateToDevices,
  };

  const hasTv = !!config.tvAnchor;
  const hasHue = hueBridgeConfigured || hueAreaId !== null || visibleHueChannels.length > 0 || hueZones.length > 0;
  const freeHeight = Math.max(0, canvasSize.h - ROOM_MAP_FIT_INSETS.top - ROOM_MAP_FIT_INSETS.bottom);

  return (
    <div ref={rootRef} className="lm-room-editor relative h-full" onKeyDown={handleKeyDown} onContextMenu={handleContextMenu} tabIndex={0}>
      <div
        className={styles.stage}
        ref={setCanvasContainer}
        data-testid="room-map-stage"
        data-stage={inRoom ? EDIT_STAGES.ROOM : EDIT_STAGES.PLAN}
        data-switched={stageSwitched || undefined}
      >
        {inRoom ? (
          <RoomView3DHost
            config={scopedConfig}
            lampFamilies={lampFamilies}
            label={t("roomMap:face.editLabel")}
            selectedId={selectedId}
            bottomInset={ROOM_MAP_FIT_INSETS.bottom}
            topInset={ROOM_MAP_FIT_INSETS.top}
            cameraCommand={cameraCommand}
            mood={mood}
            onPick={handleRoomPick}
            onMovePiece={landCarriedPiece}
            onFail={(failure) => onRoomFail?.(failure)}
          />
        ) : (
          <RoomMapCanvas
            config={config}
            pxPerMeter={pxPerMeter}
            canvasSize={canvasSize}
            showGrid={showGrid}
            gridStrokeWidth={gridStrokeWidth}
            selectedId={selectedId}
            onCanvasClick={handleCanvasClick}
            onImageLayerTransformChange={handleImageLayerTransformChange}
            onImageLayerSelect={handleImageLayerSelect}
            zoom={zoom}
            panOffset={panOffset}
            onZoomChange={setZoom}
            onPanChange={setPanOffset}
            panMode={spaceHeld}
            dragging={pieceDragging}
            onMarquee={handleMarquee}
          >
            <FootprintWalls
              corners={outline}
              dimensions={config.dimensions}
              pxPerMeter={pxPerMeter}
              zoom={zoom}
              panMode={spaceHeld}
              shape={roomShape}
              onMove={(footprint, gesture) => apply({ footprint }, { gesture })}
              onNotch={(footprint) => apply({ footprint })}
              onResizeStart={handleWallResizeStart}
              onResize={handleWallResize}
              onShapeChange={(shape, gesture) =>
                apply({ footprint: buildFootprint(shape, config.dimensions) }, gesture ? { gesture } : undefined)
              }
            />

            {/* Origin crosshair marker — always centered, extends to edges */}
            <OriginMarker widthM={widthMeters} depthM={depthMeters} pxPerMeter={pxPerMeter} />

            {config.usbStrips.map((strip) => (
              <UsbStripObject
                key={strip.stripId}
                placement={strip}
                pxPerMeter={pxPerMeter}
                selected={selectedId === usbStripObjectId(strip.stripId)}
                zoom={zoom}
                panMode={spaceHeld}
                connectionStatus={stripStatus(strip).status}
                room={roomBox}
                bendable={!(config.tvAnchor && isBacklightStrip(strip, config.tvAnchor))}
                onSelect={handleUsbStripSelect}
                onChange={handleUsbStripChange}
              />
            ))}

            {furnitureByHeight.map((f) => (
              <FurnitureObject
                key={f.id}
                placement={f}
                model={furnitureModels.get(f.id) ?? BOX_MODEL}
                pxPerMeter={pxPerMeter}
                selected={selectedId === furnitureObjectId(f.id)}
                grouped={grouped && groupSet.has(furnitureObjectId(f.id))}
                onGroupDragMove={
                  grouped && groupSet.has(furnitureObjectId(f.id))
                    ? (dx, dy) => handleGroupDragMove(furnitureObjectId(f.id), dx, dy)
                    : undefined
                }
                onGroupDragEnd={
                  grouped && groupSet.has(furnitureObjectId(f.id))
                    ? (dx, dy) => handleGroupDragEnd(furnitureObjectId(f.id), dx, dy)
                    : undefined
                }
                outside={outsideOutline(f.x + f.width / 2, f.y + f.height / 2, outline)}
                roomWidth={widthMeters}
                roomDepth={depthMeters}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={handleFurnitureSelect}
                onChange={handleFurnitureChange}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            ))}

            {config.tvAnchor && (
              <TvAnchorObject
                placement={config.tvAnchor}
                pxPerMeter={pxPerMeter}
                selected={selectedId === TV_ANCHOR_OBJECT_ID}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                room={roomBox}
                onSelect={handleTvSelect}
                onChange={handleTvChange}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
                grouped={grouped && groupSet.has(TV_ANCHOR_OBJECT_ID)}
                onGroupDragMove={
                  grouped && groupSet.has(TV_ANCHOR_OBJECT_ID) ? (dx, dy) => handleGroupDragMove(TV_ANCHOR_OBJECT_ID, dx, dy) : undefined
                }
                onGroupDragEnd={
                  grouped && groupSet.has(TV_ANCHOR_OBJECT_ID) ? (dx, dy) => handleGroupDragEnd(TV_ANCHOR_OBJECT_ID, dx, dy) : undefined
                }
              />
            )}

            {/* Hue channel dots + zone bounds — bug #53: bounds box must
                render even when no channels exist yet so the user can
                author a zone before the area is paired. Also
                mount whenever the user has at least one Hue zone AND
                the visibility toggle is on, so passive zones paint
                without needing an active selection. */}
            {(visibleHueChannels.length > 0 || activeHueZone !== null || (showHueZones && hueZones.length > 0)) && (
              <HueChannelOverlay
                channels={visibleHueChannels}
                liveChannelIds={liveChannelIds}
                pxPerMeter={pxPerMeter}
                roomWidthM={widthMeters}
                roomDepthM={depthMeters}
                zoom={zoom}
                selectedId={selectedId}
                onSelect={handleHueChannelSelect}
                onChange={handleHueChannelChange}
                panMode={spaceHeld}
                activeHueZone={activeHueZone}
                onHueZoneCenterChange={handleHueZoneCenterChange}
                allHueZones={hueZones}
                hidePassiveZoneBounds={!showHueZones}
                facings={facings}
              />
            )}

            <SnapGuideOverlay guides={snapGuides} pxPerMeter={pxPerMeter} canvasWidth={canvasSize.w} canvasHeight={canvasSize.h} />
          </RoomMapCanvas>
        )}

        <CornerControls
          roomAware={roomAware}
          stage={room3d ? { value: inRoom ? EDIT_STAGES.ROOM : EDIT_STAGES.PLAN, onChange: changeStage } : undefined}
          view={
            inRoom
              ? {
                  onZoomIn: () => setCameraCommand((c) => ({ kind: "in", seq: (c?.seq ?? 0) + 1 })),
                  onZoomOut: () => setCameraCommand((c) => ({ kind: "out", seq: (c?.seq ?? 0) + 1 })),
                  onReset: () => setCameraCommand((c) => ({ kind: "reset", seq: (c?.seq ?? 0) + 1 })),
                }
              : undefined
          }
          history={inRoom ? { canUndo, canRedo, onUndo: undo, onRedo: redo } : undefined}
          edit={inRoom ? undefined : {
            canUndo,
            canRedo,
            onUndo: undo,
            onRedo: redo,
            zoom,
            canvasSize,
            panOffset,
            anchor: { x: canvasSize.w / 2, y: ROOM_MAP_FIT_INSETS.top + freeHeight / 2 },
            onZoomChange: setZoom,
            onPanChange: setPanOffset,
            onFitToView: () => fitToView(16),
          }}
        />

        {(error || imageError || hueZoneRejection) && (
          <div className={styles.alerts}>
            {error && (
              <Callout tone="error" action={{ label: t("roomMap:persistRetry"), onClick: retrySave }}>
                {t("roomMap:persistError")}
              </Callout>
            )}
            {imageError && (
              <Callout tone="error">
                {imageErrorCode === ROOM_MAP_BACKGROUND_ERROR.TOO_LARGE
                  ? t("roomMap:imageTooLarge", { maxMb: ROOM_MAP_BACKGROUND_MAX_MB })
                  : t("roomMap:imageImportError")}
              </Callout>
            )}
            {hueZoneRejection && (
              <Callout tone="error" action={{ label: t("roomMap:hueZones.rejected.dismiss"), onClick: dismissHueZoneRejection }}>
                {t(HUE_ZONE_REJECTION_KEYS[hueZoneRejection])}
              </Callout>
            )}
          </div>
        )}

        <RoomDock
          config={scopedConfig}
          zones={areaZones}
          selectedId={selectedId}
          activeHueZoneId={activeHueZoneId}
          channels={visibleHueChannels}
          areaChannels={areaChannels}
          liveChannelIds={liveChannelIds}
          stripStatus={stripStatus}
          hueBridgeStatus={hueBridgeStatus}
          modelChoices={ROOM_VIEW_3D_AVAILABLE}
          lampFamilies={lampFamilies}
          actions={inspectorActions}
          add={{
            hasTv,
            onAddFurniture: handleAddFurniture,
            onAddTv: handleAddTv,
            onSelectTv: handleTvSelect,
            onAddStrip: handleAddUsb,
            onAddImage: () => void handleAddImage(),
            onAddZone: () => {
              if (room3d) setStage(EDIT_STAGES.PLAN);
              handleAddHueZone();
            },
          }}
          hue={
            hasHue
              ? {
                  state: deriveHueAreaState(hueBridgeConfigured, hueAreaId),
                  zoneCount: areaZones.length,
                  lightCount: visibleHueChannels.length,
                  channelsStatus,
                  refreshing: isLoadingChannels,
                  onRefresh: refreshChannels,
                  onNavigateToDevices,
                }
              : null
          }
          room={{
            dimensions: config.dimensions,
            onDimensionsChange: handleDimensionsChange,
            shape: roomShape,
            onShapeChange: handleShapeChange,
            minimumSize,
            showGrid,
            onShowGridChange: setShowGrid,
            gridStrokeWidth,
            onGridStrokeWidthChange: setGridStrokeWidth,
            showHueZones,
            onShowHueZonesChange: setShowHueZones,
            onPlan: !inRoom,
            // Spread over what is stored, so a value from a newer build survives a pick of the other.
            surfaces: ROOM_VIEW_3D_AVAILABLE
              ? {
                  value: config.surfaces,
                  onChange: (patch) =>
                    apply(
                      (cfg) => ({
                        // A hand-edited file may hold anything here; only an object is spread.
                        surfaces: { ...(typeof cfg.surfaces === "object" && cfg.surfaces !== null ? cfg.surfaces : {}), ...patch },
                      }),
                      { gesture: "room-surfaces" },
                    ),
                }
              : undefined,
          }}
          onReset={reset}
          onTemplates={onTemplates}
          onSelect={selectFromList}
          onSelectZone={selectZoneShowingPlan}
          onPopSelection={popSelection}
          onFocusEditor={focusEditor}
        />
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} actions={getContextMenuActions()} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
