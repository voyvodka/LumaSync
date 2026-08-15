import { parseObjectId } from "./objectId";

/** Hue channels are bridge-managed and `deleteById` has no branch for them.
 *  The row and the context menu encoded this separately; the menu got it wrong
 *  and offered a dead Delete. Detach via "Move to → Unassigned". */
export function canDeleteObjectKind(kind: string | undefined): boolean {
  return kind !== undefined && kind !== "hue";
}

/** `canDeleteObjectKind` for a room-map object id. */
export function canDeleteObjectId(id: string): boolean {
  return canDeleteObjectKind(parseObjectId(id)?.kind);
}
