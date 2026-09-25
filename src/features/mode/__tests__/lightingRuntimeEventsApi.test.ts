import { describe, expect, it, vi } from "vitest";

import {
  LIGHTING_RUNTIME_CHANGED_EVENT,
  type LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";

import { listenLightingRuntime } from "../lightingRuntimeEventsApi";

let deliver: ((event: { payload: LightingRuntimeSnapshot }) => void) | null = null;
const listenMock = vi.fn((_event: string, handler: typeof deliver) => {
  deliver = handler;
  return Promise.resolve(() => {});
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: LightingRuntimeSnapshot }) => void) =>
    listenMock(event, handler),
}));

function snapshot(revision: number): LightingRuntimeSnapshot {
  return {
    revision,
    mode: { kind: "off" },
    active: false,
    activeTargets: [],
    selectedTargets: [],
    phase: "idle",
    requestId: null,
    hueHeldOutReason: null,
    bootHueRetry: null,
    lastOutcome: null,
  };
}

describe("listenLightingRuntime", () => {
  it("delivers snapshots in revision order and drops one that arrives late", async () => {
    const seen: number[] = [];
    await listenLightingRuntime((s) => seen.push(s.revision));
    expect(listenMock).toHaveBeenCalledWith(LIGHTING_RUNTIME_CHANGED_EVENT, expect.any(Function));

    for (const revision of [1, 3, 2, 3, 4]) {
      deliver?.({ payload: snapshot(revision) });
    }

    expect(seen).toEqual([1, 3, 4]);
  });
});
