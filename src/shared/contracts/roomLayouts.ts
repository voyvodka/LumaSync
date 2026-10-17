/**
 * Room layouts: several rooms the user keeps, one of them the room the lights follow. Frontend-owned,
 * stored in `ShellState.roomLayouts`. The active room is never copied in here: it stays at
 * `ShellState.roomMap`, which every Rust reader keeps reading, so its entry carries no `config`. Rust
 * reads this key only for the image paths its startup prune must keep. See docs/architecture/room-map.md.
 */

import type { RoomMapConfig } from "./roomMap";

export const ROOM_LAYOUTS_MAX = 12;
export const ROOM_NAME_MAX = 40;

export interface StoredRoomLayout {
  /** A uuid; the room a file had before layouts existed is `room-1`. */
  id: string;
  /** Absent ⇒ the localized default, so an unnamed room follows a language change. */
  name?: string;
  /** Absent on the active room, whose config is `roomMap`; present on every other one. */
  config?: RoomMapConfig;
}

/** `rooms` in the order shown. Absent from the file ⇒ one implicit room, the `roomMap` there is. */
export interface StoredRoomLayouts {
  activeId: string;
  rooms: StoredRoomLayout[];
}

export const FIRST_ROOM_ID = "room-1";
