/**
 * The mock's world, and the only mutable thing in `mock/`.
 *
 * Fixtures are not constants. `connect_serial_port` has to change what
 * `get_serial_connection_status` answers next, and `start_hue_stream` has to
 * change `get_hue_stream_status` — without that, a whole class of bug (state
 * written on one call and read on another) simply cannot appear, and the mock
 * would train you on an app that has none of it.
 */

import type { ScenarioId } from "./scenarios";

export interface MockWorld {
  scenario: ScenarioId;
  /** Bumped on every scenario change. A response that lands under a different
   *  generation than it was issued under is a stale read; see `dispatch.ts`. */
  generation: number;

  serial: {
    ports: { name: string; supported: boolean; product: string | null }[];
    connectedPort: string | null;
  };
  wled: {
    /** Discovery answers from here; an empty list is a legitimate scenario. */
    devices: { host: string; name: string; ledCount: number }[];
    connectedHost: string | null;
  };
  hue: {
    bridges: { id: string; ip: string; name: string }[];
    /** `null` means never paired; a string means an application key exists. */
    appKey: string | null;
    reachable: boolean;
    /** `false` reproduces the expired-key case, which used to read as an empty area. */
    credentialValid: boolean;
    areas: { id: string; name: string; channelCount: number }[];
    channels: { index: number; name: string }[];
    streaming: boolean;
    /** Counts down on each readiness poll, reproducing the link-button wait. */
    linkButtonPressesRemaining: number;
  };
  displays: { id: string; name: string; width: number; height: number }[];
  capture: { permissionGranted: boolean };
  lighting: { mode: string };
  /** Every write through `plugin:store` fails, reproducing the persist-error banners. */
  persistFails: boolean;
  /** Per-command overrides set from the panel: force one command to fail. */
  forcedFailures: Set<string>;
  /** Added to every fixture's delay. Set from the panel to expose races. */
  extraLatencyMs: number;
  /**
   * What `shell-state.json` holds at boot. Seeded per scenario because a good
   * half of "is anything configured" is answered from persisted state rather
   * than from a command — a furnished world with an empty store still greets
   * you with the first-run banner.
   */
  shellState: Record<string, unknown>;
}

let world: MockWorld;

export function getWorld(): MockWorld {
  return world;
}

export function setWorld(next: MockWorld): void {
  const generation = world === undefined ? 1 : world.generation + 1;
  world = { ...next, generation };
}

/** Narrow mutations from handlers — a connect has to be visible to the next status read. */
export function mutate(apply: (draft: MockWorld) => void): void {
  apply(world);
}
