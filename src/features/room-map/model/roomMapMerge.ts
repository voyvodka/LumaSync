import type { HueChannelPlacement, RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";

const hueChannelKey = (channel: HueChannelPlacement) =>
  `${channel.entertainmentAreaId ?? ""}:${channel.channelIndex}`;
const usbStripKey = (strip: UsbStripPlacement) => strip.stripId;

/** The fields of `from` → `to` that differ, removed ones as `undefined`. */
function changedFields<T extends object>(from: T, to: T): Partial<T> {
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)]) as Set<keyof T & string>) {
    if (from[key] !== to[key]) changed[key] = to[key];
  }
  return changed as Partial<T>;
}

/** `stored` with the editor's own changes from `base` to `next` applied: a record it added goes in
 *  whole, one it changed takes only the fields it changed (another writer's `portName` or
 *  `ledCount` on the same strip stays), one it deleted goes, everything else stays as stored. */
function mergeRecords<T extends object>(
  stored: readonly T[],
  base: readonly T[],
  next: readonly T[],
  keyOf: (record: T) => string,
): T[] {
  const baseByKey = new Map(base.map((record) => [keyOf(record), record]));
  const nextKeys = new Set(next.map(keyOf));
  const deleted = new Set([...baseByKey.keys()].filter((key) => !nextKeys.has(key)));
  const changed = new Map(
    next
      .filter((record) => baseByKey.get(keyOf(record)) !== record)
      .map((record) => [keyOf(record), record]),
  );
  const merged = stored
    .filter((record) => !deleted.has(keyOf(record)))
    .map((record) => {
      const key = keyOf(record);
      const edit = changed.get(key);
      const before = baseByKey.get(key);
      if (edit === undefined) return record;
      return before === undefined ? edit : { ...record, ...changedFields(before, edit) };
    });
  const present = new Set(merged.map(keyOf));
  return [...merged, ...[...changed.values()].filter((record) => !present.has(keyOf(record)))];
}

/**
 * The room map the editor's save writes: the stored one with only what the editor changed since
 * its own last save (`base`) applied — the USB roster, LED Setup's count sync and the Devices
 * channel map write `usbStrips` and `hueChannels` too, so those two merge record by record rather
 * than as whole arrays. Fields compare by reference, which the reducer keeps for anything an edit
 * did not touch. A field the editor removed is written `undefined`, so it leaves the file. With no
 * `base` (nothing loaded, or the last save failed) `next` is written whole.
 */
export function mergeEditorSave(
  stored: RoomMapConfig,
  base: RoomMapConfig | null,
  next: RoomMapConfig,
): RoomMapConfig {
  if (base === null) return next;
  const merged: Record<string, unknown> = { ...stored };
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]) as Set<keyof RoomMapConfig>;
  for (const key of keys) {
    if (base[key] === next[key]) continue;
    if (key === "usbStrips") {
      merged.usbStrips = mergeRecords(stored.usbStrips ?? [], base.usbStrips ?? [], next.usbStrips ?? [], usbStripKey);
    } else if (key === "hueChannels") {
      merged.hueChannels = mergeRecords(
        stored.hueChannels ?? [],
        base.hueChannels ?? [],
        next.hueChannels ?? [],
        hueChannelKey,
      );
    } else {
      merged[key] = next[key];
    }
  }
  return merged as unknown as RoomMapConfig;
}
