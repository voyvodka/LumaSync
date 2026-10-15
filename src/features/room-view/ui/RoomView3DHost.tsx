import { lazy, Suspense } from "react";

import { useWindowVisible } from "@/features/shell/windowVisibility";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import type { LampFamily } from "../model/lampFamily";
import type { CameraCommand } from "./RoomView3D";
import styles from "./RoomView3DHost.module.css";

// Spike: built into dev builds and into a measuring build with VITE_ROOM_VIEW_SPIKE=1. A release
// build drops the import and never emits the three.js chunk; `verify:chunk-budget` fails if it does.
const RoomView3D =
  import.meta.env.DEV || import.meta.env.VITE_ROOM_VIEW_SPIKE === "1"
    ? lazy(() => import("./RoomView3D"))
    : null;

export const ROOM_VIEW_3D_AVAILABLE = RoomView3D !== null;

/** The 3D room, filling its slot. It holds a WebGL context only while the window is on screen:
 *  hidden, it unmounts and hands everything back. */
export function RoomView3DHost(props: {
  config: RoomMapConfig;
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  label: string;
  selectedId?: string | null;
  bottomInset?: number;
  cameraCommand?: CameraCommand;
  onPick?: (objectId: string | null) => void;
  onMovePiece?: (objectId: string, sceneX: number, sceneZ: number) => void;
  onFail: (error: unknown) => void;
}) {
  const visible = useWindowVisible();
  if (!RoomView3D || !visible) return null;
  return (
    <div className={styles.stage} data-testid="room-view-3d">
      <Suspense fallback={null}>
        <RoomView3D {...props} />
      </Suspense>
    </div>
  );
}
