import { parseObjectId } from "./objectId";
import { ROOM_OBJECT_KINDS } from "./roomObjectKinds";

/** Hue channels are bridge-managed and have no `remove` in `ROOM_OBJECT_KINDS`.
 *  The row and the context menu encoded this separately; the menu got it wrong
 *  and offered a dead Delete. Detach via "Move to → Unassigned". */
export function canDeleteObjectKind(kind: string | undefined): boolean {
  if (kind === undefined || !Object.prototype.hasOwnProperty.call(ROOM_OBJECT_KINDS, kind)) return false;
  return ROOM_OBJECT_KINDS[kind as keyof typeof ROOM_OBJECT_KINDS].remove !== null;
}

/** `canDeleteObjectKind` for a room-map object id. */
export function canDeleteObjectId(id: string): boolean {
  return canDeleteObjectKind(parseObjectId(id)?.kind);
}
