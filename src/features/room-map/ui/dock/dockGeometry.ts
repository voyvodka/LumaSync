import type { FitInsets } from "../../state/useRoomMapViewport";

/** The dock's outer height: two 32 px rows, 6 px between, 10 px padding and a 1 px border. It never
 *  changes with what it shows, so nothing moves under the pointer. */
export const DOCK_HEIGHT_PX = 92;
/** Its gap from the canvas's bottom edge. */
export const DOCK_BOTTOM_PX = 12;
/** What a fit keeps the room clear of: the switch and corner row above, the dock below. */
export const ROOM_MAP_FIT_INSETS: FitInsets = { top: 48, bottom: DOCK_HEIGHT_PX + DOCK_BOTTOM_PX + 8 };
/** The templates drawer over the dock: a previewed room is fitted above it, not under its cards. */
const TEMPLATES_DRAWER_PX = 112;
export const ROOM_MAP_PREVIEW_INSETS: FitInsets = { top: ROOM_MAP_FIT_INSETS.top, bottom: ROOM_MAP_FIT_INSETS.bottom + TEMPLATES_DRAWER_PX };
