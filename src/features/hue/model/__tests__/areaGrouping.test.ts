import { describe, expect, it } from "vitest";

import {
  ACTIVE_STREAMER_REASON,
  applyAreaReadinessSnapshot,
  flattenAreaGroups,
  normalizeAreas,
} from "../areaGrouping";
import type { HueEntertainmentAreaSummary } from "../../hueOnboardingApi";
import type { HueAreaReadiness } from "../onboardingTypes";

const area = (
  fields: Pick<HueEntertainmentAreaSummary, "id" | "name"> &
    Partial<HueEntertainmentAreaSummary>,
): HueEntertainmentAreaSummary => ({ channelCount: 0, activeStreamer: false, ...fields });

const readiness = (ready: boolean, reasons: string[] = []): HueAreaReadiness => ({
  ready,
  reasons,
  code: ready ? "HUE_STREAM_READY" : "HUE_STREAM_NOT_READY",
  message: "",
  details: null,
});

describe("normalizeAreas", () => {
  it("groups by room and sorts by room then area name", () => {
    const groups = normalizeAreas(
      [
        area({ id: "3", name: "Zeta", roomName: "Salon" }),
        area({ id: "1", name: "Alpha", roomName: "Bedroom" }),
        area({ id: "2", name: "Beta", roomName: "Salon" }),
      ],
      new Map(),
    );

    expect(groups.map((group) => group.roomName)).toEqual(["Bedroom", "Salon"]);
    expect(groups[1]?.areas.map((area) => area.name)).toEqual(["Beta", "Zeta"]);
  });

  it("falls back to 'Other rooms' for a missing or blank room name", () => {
    const groups = normalizeAreas(
      [
        area({ id: "1", name: "Alpha" }),
        area({ id: "2", name: "Beta", roomName: "   " }),
      ],
      new Map(),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.roomName).toBe("Other rooms");
    // Both land in one group, but a blank `roomName` sorts under "" while an
    // absent one sorts under "other rooms", so Beta precedes Alpha. Pinned as
    // the shipped behaviour, not endorsed.
    expect(groups[0]?.areas.map((area) => area.id)).toEqual(["2", "1"]);
  });

  it("attaches a known readiness snapshot and leaves unknown ones null", () => {
    const groups = normalizeAreas(
      [
        area({ id: "1", name: "Alpha", roomName: "Salon" }),
        area({ id: "2", name: "Beta", roomName: "Salon" }),
      ],
      new Map([["1", readiness(true)]]),
    );

    expect(groups[0]?.areas[0]?.readiness?.ready).toBe(true);
    expect(groups[0]?.areas[1]?.readiness).toBeNull();
  });
});

describe("flattenAreaGroups", () => {
  it("returns every area across groups, in group order", () => {
    const groups = normalizeAreas(
      [
        area({ id: "1", name: "Alpha", roomName: "Bedroom" }),
        area({ id: "2", name: "Beta", roomName: "Salon" }),
      ],
      new Map(),
    );

    expect(flattenAreaGroups(groups).map((area) => area.id)).toEqual(["1", "2"]);
  });
});

describe("applyAreaReadinessSnapshot", () => {
  const groups = () =>
    normalizeAreas(
      [
        area({ id: "1", name: "Alpha", roomName: "Salon" }),
        area({ id: "2", name: "Beta", roomName: "Salon" }),
      ],
      new Map(),
    );

  it("sets activeStreamer when the readiness reasons name a foreign streamer", () => {
    const next = applyAreaReadinessSnapshot(groups(), "1", readiness(false, [ACTIVE_STREAMER_REASON]));

    expect(next[0]?.areas[0]?.activeStreamer).toBe(true);
    expect(next[0]?.areas[0]?.readiness?.ready).toBe(false);
  });

  it("clears activeStreamer once the foreign session releases (A3.1)", () => {
    const blocked = applyAreaReadinessSnapshot(groups(), "1", readiness(false, [ACTIVE_STREAMER_REASON]));
    const freed = applyAreaReadinessSnapshot(blocked, "1", readiness(true));

    expect(freed[0]?.areas[0]?.activeStreamer).toBe(false);
    expect(freed[0]?.areas[0]?.readiness?.ready).toBe(true);
  });

  it("touches only the addressed area", () => {
    const next = applyAreaReadinessSnapshot(groups(), "1", readiness(true));

    expect(next[0]?.areas[1]?.readiness).toBeNull();
    // The bridge always sends `activeStreamer`, so "untouched" is the incoming
    // `false`, not an absent key.
    expect(next[0]?.areas[1]?.activeStreamer).toBe(false);
  });

  it("is a no-op for an unknown area id", () => {
    const next = applyAreaReadinessSnapshot(groups(), "missing", readiness(true));

    expect(next[0]?.areas.every((area) => area.readiness === null)).toBe(true);
  });
});
