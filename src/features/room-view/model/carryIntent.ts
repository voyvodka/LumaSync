import type { PickKind } from "./picking";

/** What the 3D room can pick up and carry. */
export const CARRIED_KINDS: ReadonlySet<PickKind> = new Set<PickKind>(["furniture"]);

/**
 * Whether a press starts carrying what it landed on: only the piece already selected does. A drag
 * that began on any piece used to carry it, so turning the room from over the sofa moved the sofa;
 * now the first click selects and a drag from anything else turns the room.
 */
export function pressStartsCarry(
  picked: { id: string; kind: PickKind } | undefined,
  selectedId: string | null,
  carried: ReadonlySet<PickKind> = CARRIED_KINDS,
): boolean {
  return picked !== undefined && picked.id === selectedId && carried.has(picked.kind);
}
