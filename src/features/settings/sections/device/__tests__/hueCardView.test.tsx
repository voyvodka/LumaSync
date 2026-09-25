// The Hue card's sixteen states used to be dispatched by hand in 22 places
// (96 `hueBridgeState ===` comparisons), so a new state compiled and rendered
// a card with no pill text, no body and no footer. One exhaustive table now.

import { describe, expect, it } from "vitest";

import type { HueBridgeCardState } from "@/features/hue/model/hueBridgeCardState";
import type { Equals } from "@/test/typeEquals";

import { HUE_CARD_ACTIONS, HUE_CARD_VIEW, type HueCardView } from "../hueCardView";

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

describe("HUE_CARD_VIEW", () => {
  it("has exactly one row per card state", () => {
    const listed: Equals<(typeof STATES)[number], HueBridgeCardState> = true;
    const covered: Equals<keyof typeof HUE_CARD_VIEW, HueBridgeCardState> = true;
    expect(listed && covered).toBe(true);
    expect(Object.keys(HUE_CARD_VIEW).sort()).toEqual([...STATES].sort());
  });

  it("does not compile with a state missing", () => {
    const { offline: _offline, ...withoutOffline } = HUE_CARD_VIEW;
    // @ts-expect-error — an unreachable bridge would have no card.
    const incomplete = withoutOffline satisfies Record<HueBridgeCardState, HueCardView>;
    expect(Object.keys(incomplete)).not.toContain("offline");
  });

  it("does not compile with a field missing from a row", () => {
    const { actions: _actions, ...idleWithoutActions } = HUE_CARD_VIEW.idle;
    // @ts-expect-error — an idle card would have no footer.
    const row = idleWithoutActions satisfies HueCardView;
    expect(row).not.toHaveProperty("actions");
  });

  it("gives every state a pill label and at least one footer action", () => {
    for (const state of STATES) {
      const view: HueCardView = HUE_CARD_VIEW[state];
      expect(view.pill.label, state).toMatch(/^hue:/);
      expect(view.actions.length, state).toBeGreaterThan(0);
      for (const id of view.actions) expect(HUE_CARD_ACTIONS, `${state} → ${id}`).toHaveProperty(id);
    }
  });
});
