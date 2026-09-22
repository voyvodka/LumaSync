import { describe, expect, it } from "vitest";

import { parseSkippedChannelIds } from "../hueWritebackResult";

// Verbatim from `skipped_details` in src-tauri/src/commands/room_map/save_load.rs.
const UNMAPPABLE =
  "Channel(s) 3, 12 have no single bridge position to write (gradient, grouped or unknown).";

describe("parseSkippedChannelIds", () => {
  it("reads the bridge ids the write skipped", () => {
    expect(parseSkippedChannelIds(UNMAPPABLE)).toEqual([3, 12]);
  });

  it("reads them when id-less placements are reported first", () => {
    expect(
      parseSkippedChannelIds(`1 placement(s) carry no bridge channel id. ${UNMAPPABLE}`),
    ).toEqual([3, 12]);
  });

  it("names nothing when only id-less placements were skipped", () => {
    expect(parseSkippedChannelIds("2 placement(s) carry no bridge channel id.")).toEqual([]);
  });

  it("names nothing for an absent or reworded detail", () => {
    expect(parseSkippedChannelIds(null)).toEqual([]);
    expect(parseSkippedChannelIds("Skipped 3.")).toEqual([]);
  });
});
