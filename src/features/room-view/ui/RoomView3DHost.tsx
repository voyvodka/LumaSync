import { lazy, Suspense } from "react";

import { useWindowVisible } from "@/features/shell/windowVisibility";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

// Spike: built into dev builds and into a measuring build with VITE_ROOM_VIEW_SPIKE=1. A release
// build drops the import and never emits the three.js chunk; `verify:chunk-budget` fails if it does.
const RoomView3D =
  import.meta.env.DEV || import.meta.env.VITE_ROOM_VIEW_SPIKE === "1"
    ? lazy(() => import("./RoomView3D"))
    : null;

export const ROOM_VIEW_3D_AVAILABLE = RoomView3D !== null;

/** The 3D view over the room map's canvas. It holds a WebGL context only while the window is on
 *  screen: hidden, it unmounts and hands everything back. */
export function RoomView3DHost(props: { config: RoomMapConfig; label: string; onFail: (error: unknown) => void }) {
  const visible = useWindowVisible();
  if (!RoomView3D || !visible) return null;
  return (
    <div className="absolute inset-0 z-20" data-testid="room-view-3d">
      <Suspense fallback={null}>
        <RoomView3D {...props} />
      </Suspense>
    </div>
  );
}
