import { type CSSProperties, lazy, type MutableRefObject, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useWindowPresence, type WindowPresence } from "@/features/shell/windowVisibility";
import { useHeldFlag, useLateFlag } from "@/shared/lib/useHeldFlag";
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import type { LampFamily } from "../model/lampFamily";
import { hexCss, type RoomMood, roomMood } from "../model/roomMood";
import type { CameraCommand, MovePiece, RoomDropTarget } from "./RoomView3D";
import styles from "./RoomView3DHost.module.css";

// Spike: built into dev builds and into a measuring build with VITE_ROOM_VIEW_SPIKE=1. A release
// build drops the import and never emits the three.js chunk; `verify:chunk-budget` fails if it does.
const BUILT = import.meta.env.DEV || import.meta.env.VITE_ROOM_VIEW_SPIKE === "1";
let loaded: typeof import("./RoomView3D") | null = null;
const load = () =>
  import("./RoomView3D").then((module) => {
    loaded = module;
    return module;
  });
const RoomView3D = BUILT ? lazy(load) : null;

export const ROOM_VIEW_3D_AVAILABLE = RoomView3D !== null;

/** Starts fetching three.js while the room map is still being read, rather than after. */
export function preloadRoomView3D(): void {
  if (BUILT) void load();
}

/** Flicking between this window and another, or across Spaces, rebuilt the room on every return. */
export const COVERED_KEEP_MS = 30_000;

/** A rebuild with three.js already loaded usually draws within this, so its wait never shows. */
const WAIT_SHOWN_AFTER_MS = 200;
let drawnOnce = false;

// Covered only keeps a room that was on screen: one never seen is not built behind another window.
function useKeptOnScreen(presence: WindowPresence): boolean {
  const [expired, setExpired] = useState(presence !== "visible");
  useEffect(() => {
    if (presence !== "covered") {
      setExpired(presence === "hidden");
      return;
    }
    const timer = setTimeout(() => setExpired(true), COVERED_KEEP_MS);
    return () => clearTimeout(timer);
  }, [presence]);
  return presence === "visible" || (presence === "covered" && !expired);
}

function skyStyle(mood: RoomMood): CSSProperties {
  return { "--lm-room-sky-top": hexCss(mood.sky.top), "--lm-room-sky-mid": hexCss(mood.sky.mid) } as CSSProperties;
}

/** The 3D room, filling its slot. It holds a WebGL context only while the window is on screen:
 *  put away, it unmounts and hands everything back at once; covered, after `COVERED_KEEP_MS`. */
export function RoomView3DHost(props: {
  config: RoomMapConfig;
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  label: string;
  selectedId?: string | null;
  zones?: ZoneMarks | null;
  bottomInset?: number;
  topInset?: number;
  cameraCommand?: CameraCommand;
  mood?: RoomMood;
  onPick?: (objectId: string | null) => void;
  onHover?: (objectId: string | null, clientX: number, clientY: number) => void;
  onMovePiece?: MovePiece;
  onFail: (error: unknown) => void;
  dropRef?: MutableRefObject<RoomDropTarget | null>;
  morphKey?: number;
}) {
  const { t } = useTranslation();
  const kept = useKeptOnScreen(useWindowPresence());
  // A parked view is adopted already drawn: switching faces must not flash the wait.
  const [drawn, setDrawn] = useState(() => loaded?.parkedViewReady() ?? false);
  if (!kept && drawn) setDrawn(false);
  const handleDrawn = useCallback(() => {
    drawnOnce = true;
    setDrawn(true);
  }, []);
  // The first open carries on from the map's own loading line, so a delay would blink it.
  const [firstOpen] = useState(() => !drawnOnce);
  const waiting = useHeldFlag(useLateFlag(kept && !drawn, firstOpen ? 0 : WAIT_SHOWN_AFTER_MS));
  if (!RoomView3D || !kept) return null;
  return (
    <div className={styles.stage} data-testid="room-view-3d" style={skyStyle(props.mood ?? roomMood(null))}>
      <Suspense fallback={null}>
        <RoomView3D {...props} onDrawn={handleDrawn} />
      </Suspense>
      <span className={styles.waiting} data-shown={waiting || undefined} role="status" aria-hidden={!waiting}>
        {t("roomMap:loading")}
      </span>
    </div>
  );
}
