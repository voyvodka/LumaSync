// `update_hue_channel_positions` names the channels it skipped only in the
// prose of `details` (`skipped_details` in room_map/save_load.rs). Parsed here
// rather than displayed: the text is English. A format change degrades to "some
// channels were skipped", and the re-read after every save corrects the sync
// state either way.

const SKIPPED_IDS = /Channel\(s\) ([\d, ]+) have no single bridge position/;

/** Bridge ids the write skipped, `[]` when none are named. */
export function parseSkippedChannelIds(details: string | null | undefined): number[] {
  const match = details ? SKIPPED_IDS.exec(details) : null;
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id));
}
