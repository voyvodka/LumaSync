/** `selectedId` crosses component boundaries as a plain string; these are the only sites that spell the prefixes out. */

export const TV_ANCHOR_OBJECT_ID = "tv";

const FURNITURE_PREFIX = "furniture-";
const USB_PREFIX = "usb-";
const HUE_PREFIX = "hue-";
const IMAGE_PREFIX = "img-";

export const furnitureObjectId = (furnitureId: string): string =>
  `${FURNITURE_PREFIX}${furnitureId}`;
export const usbStripObjectId = (stripId: string): string => `${USB_PREFIX}${stripId}`;
export const hueChannelObjectId = (channelIndex: number): string =>
  `${HUE_PREFIX}${channelIndex}`;
export const imageLayerObjectId = (layerId: string): string => `${IMAGE_PREFIX}${layerId}`;

/** What identifies one object of each kind inside the room map config. */
interface RoomObjectKeys {
  tv: Record<never, never>;
  furniture: { furnitureId: string };
  usb: { stripId: string };
  hue: { channelIndex: number };
  image: { layerId: string };
}

export type RoomObjectKind = keyof RoomObjectKeys;

/** A parsed object id, narrowed to one kind when `K` is. */
export type RoomObjectRef<K extends RoomObjectKind = RoomObjectKind> = {
  [P in K]: { kind: P } & RoomObjectKeys[P];
}[K];

export type ParsedObjectId = RoomObjectRef;

/** A malformed `hue-` suffix yields `channelIndex: NaN`, not null — rejecting it would skip branches callers currently enter. */
export function parseObjectId(objectId: string): ParsedObjectId | null {
  if (objectId === TV_ANCHOR_OBJECT_ID) return { kind: "tv" };
  if (objectId.startsWith(FURNITURE_PREFIX)) {
    return { kind: "furniture", furnitureId: objectId.slice(FURNITURE_PREFIX.length) };
  }
  if (objectId.startsWith(USB_PREFIX)) {
    return { kind: "usb", stripId: objectId.slice(USB_PREFIX.length) };
  }
  if (objectId.startsWith(HUE_PREFIX)) {
    return { kind: "hue", channelIndex: parseInt(objectId.slice(HUE_PREFIX.length), 10) };
  }
  if (objectId.startsWith(IMAGE_PREFIX)) {
    return { kind: "image", layerId: objectId.slice(IMAGE_PREFIX.length) };
  }
  return null;
}
