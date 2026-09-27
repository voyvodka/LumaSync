// The Hue card's sixteen states used to be dispatched by hand in 22 places
// (96 `hueBridgeState ===` comparisons), so a new state compiled and rendered
// a card with no pill text, no body and no footer. One exhaustive table now.

import { describe, expect, it } from "vitest";

import type { HueBridgeCardState } from "@/features/hue/model/hueBridgeCardState";
import type { Equals } from "@/test/typeEquals";

import { HUE_ACTIONS, HUE_STATE_VIEW, type HueStateView } from "../hueStateView";

const STATES = [
  "stopPartial",
  "gateBlocked",
  "streaming",
  "reconnecting",
  "streamFailed",
  "offline",
  "pairingLinkButton",
  "pairingTimedOut",
  "pairingDeferred",
  "pairingFailed",
  "authError",
  "pairing",
  "unpaired",
  "checkingCredentials",
  "areaSelect",
  "areaBusy",
  "statusUnknown",
  "stale",
  "idle",
] as const satisfies readonly HueBridgeCardState[];

describe("HUE_STATE_VIEW", () => {
  it("has exactly one row per bridge state", () => {
    const listed: Equals<(typeof STATES)[number], HueBridgeCardState> = true;
    const covered: Equals<keyof typeof HUE_STATE_VIEW, HueBridgeCardState> = true;
    expect(listed && covered).toBe(true);
    expect(Object.keys(HUE_STATE_VIEW).sort()).toEqual([...STATES].sort());
  });

  it("does not compile with a state missing", () => {
    const { offline: _offline, ...withoutOffline } = HUE_STATE_VIEW;
    // @ts-expect-error — an unreachable bridge would have no word.
    const incomplete = withoutOffline satisfies Record<HueBridgeCardState, HueStateView>;
    expect(Object.keys(incomplete)).not.toContain("offline");
  });

  it("does not compile with a field missing from a row", () => {
    const { primary: _primary, ...idleWithoutPrimary } = HUE_STATE_VIEW.idle;
    // @ts-expect-error — a state has to say whether it has a thing to do next.
    const row = idleWithoutPrimary satisfies HueStateView;
    expect(row).not.toHaveProperty("primary");
  });

  it("gives every state a word and names only actions that exist", () => {
    for (const state of STATES) {
      const view: HueStateView = HUE_STATE_VIEW[state];
      expect(view.word, state).toMatch(/^hue:/);
      for (const id of [view.primary, ...view.secondary, ...view.more]) {
        if (id !== null) expect(HUE_ACTIONS, `${state} → ${id}`).toHaveProperty(id);
      }
    }
  });

  // One amber at rest: the primary is not offered a second time beside it or behind "…".
  it("never lists the primary again in the same state", () => {
    for (const state of STATES) {
      const view: HueStateView = HUE_STATE_VIEW[state];
      if (view.primary === null) continue;
      expect([...view.secondary, ...view.more], state).not.toContain(view.primary);
    }
  });

  // Choosing an area lives on the area row; a state that asks for it has to show that row.
  it("puts an area primary only on a state with an area row to change", () => {
    for (const state of STATES) {
      const view: HueStateView = HUE_STATE_VIEW[state];
      if (view.primary === "changeArea") expect(view.area, state).toBe("change");
    }
  });

  it("leaves every state a way out: an action, or something behind …", () => {
    for (const state of STATES) {
      const view: HueStateView = HUE_STATE_VIEW[state];
      const ways = [view.primary, ...view.secondary, ...view.more].filter((id) => id !== null);
      expect(ways.length, state).toBeGreaterThan(0);
    }
  });
});
