/**
 * A stand-in for the Rust health monitor, for tests that mock
 * `hueHealthApi`: `vi.mock(path, async () => (await import(...)).fakeHueHealthApi)`.
 * Rust publishes; this lets a test publish the same way and see what the
 * store asked for.
 */

import { vi } from "vitest";

import {
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeState,
  type HueRuntimeStatus,
} from "@/shared/contracts/hue";
import type {
  HueAreaHealth,
  HueBridgeHealth,
  HueHealthSnapshot,
  HueStreamHealth,
} from "@/shared/contracts/hueHealth";

export interface HealthChange {
  configured?: boolean;
  bridge?: Partial<HueBridgeHealth>;
  area?: HueAreaHealth | null;
  stream?: Partial<HueStreamHealth>;
}

let current: HueHealthSnapshot = idleHealth();
let listener: ((snapshot: HueHealthSnapshot) => void) | null = null;

export function runtimeStatus(
  state: HueRuntimeState,
  code: HueRuntimeStatus["code"] = state === HUE_RUNTIME_STATES.RUNNING
    ? "HUE_STREAM_RUNNING"
    : "HUE_STREAM_IDLE",
  extra: Partial<HueRuntimeStatus> = {},
): HueRuntimeStatus {
  return {
    state,
    code,
    message: state,
    details: null,
    triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM,
    ...extra,
  };
}

export function idleHealth(): HueHealthSnapshot {
  return {
    revision: 1,
    configured: true,
    bridge: { verdict: "reachable", probing: false, gaveUp: false },
    area: null,
    stream: { active: false, status: runtimeStatus(HUE_RUNTIME_STATES.IDLE) },
  };
}

function applyChange(base: HueHealthSnapshot, change: HealthChange): HueHealthSnapshot {
  return {
    ...base,
    configured: change.configured ?? base.configured,
    bridge: { ...base.bridge, ...change.bridge },
    area: change.area === undefined ? base.area : change.area,
    stream: { ...base.stream, ...change.stream },
    revision: base.revision + 1,
  };
}

/** What the next read answers with, without an event. */
export function setHealth(change: HealthChange): HueHealthSnapshot {
  current = applyChange(current, change);
  return current;
}

/** Rust publishes a new revision to every window. */
export function publishHealth(change: HealthChange): HueHealthSnapshot {
  current = applyChange(current, change);
  listener?.(current);
  return current;
}

export function currentHealth(): HueHealthSnapshot {
  return current;
}

export const fakeHueHealthApi = {
  getHueHealth: vi.fn(() => Promise.resolve(current)),
  watchHueHealth: vi.fn((_watch: unknown) => Promise.resolve(current)),
  retryHueHealth: vi.fn(() => Promise.resolve(current)),
  listenHueHealth: vi.fn((onSnapshot: (snapshot: HueHealthSnapshot) => void) => {
    listener = onSnapshot;
    return Promise.resolve(() => {
      if (listener === onSnapshot) listener = null;
    });
  }),
};

/** Back to an idle, paired, reachable bridge with default answers. */
export function resetHealth(initial: HealthChange = {}): void {
  current = applyChange({ ...idleHealth(), revision: 0 }, initial);
  listener = null;
  fakeHueHealthApi.getHueHealth.mockReset().mockImplementation(() => Promise.resolve(current));
  fakeHueHealthApi.watchHueHealth.mockReset().mockImplementation(() => Promise.resolve(current));
  fakeHueHealthApi.retryHueHealth.mockReset().mockImplementation(() => Promise.resolve(current));
  fakeHueHealthApi.listenHueHealth.mockReset().mockImplementation((onSnapshot) => {
    listener = onSnapshot;
    return Promise.resolve(() => {
      if (listener === onSnapshot) listener = null;
    });
  });
}
