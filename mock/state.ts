/**
 * The mock's world, and the only mutable thing in `mock/`.
 *
 * Fixtures are not constants. `connect_serial_port` has to change what
 * `get_serial_connection_status` answers next, and `start_hue_stream` has to
 * change `get_hue_stream_status` — without that, a whole class of bug (state
 * written on one call and read on another) simply cannot appear, and the mock
 * would train you on an app that has none of it.
 *
 * The world survives a reload through `sessionStorage`. That matters more than
 * it sounds: composing a world by hand — two strips, one bridge, three
 * channels, capture denied — is real work, and losing it to an accidental
 * refresh would make anyone stop composing and go back to presets.
 */

import type { LightingModeConfig } from "../src/features/mode/model/contracts";
import type {
  FirmwareProfile,
  LedChipType,
  WledProtocol,
} from "../src/shared/contracts/device";
import type { TelemetryQueueHealth } from "../src/shared/contracts/telemetry";
import type { ShellState } from "../src/shared/contracts/shell";
import type { ScenarioId } from "./scenarios";

export interface MockSerialPort {
  name: string;
  /** The VID/PID allowlist verdict. A port can enumerate and still be refused. */
  supported: boolean;
  vid: number;
  pid: number;
  manufacturer: string | null;
  product: string | null;
  /** What `connect_serial_port` does when this port is opened. A port that
   *  enumerates but refuses to open is a distinct, previously unreachable path. */
  connectOutcome: keyof typeof import("../src/shared/contracts/device").SERIAL_CONNECT_STATUS;
  /** What the firmware advertises at handshake. Disagreeing with the profile
   *  chosen in Settings is a shipped bug that had no way to be reproduced. */
  firmwareProfile: FirmwareProfile;
  chipType: LedChipType;
}

export interface MockWledDevice {
  host: string;
  name: string;
  ledCount: number;
  port: number;
  protocol: WledProtocol;
}

export interface MockHueChannel {
  index: number;
  name: string;
  /** What a save wrote to the bridge. Absent ⇒ the fixture's default position. */
  stored?: { x: number; y: number; z: number | null };
}

export interface MockHueArea {
  id: string;
  name: string;
  channelCount: number;
  roomName: string | null;
  /** Another app already owns the bridge's single entertainment slot. */
  activeStreamer: boolean;
}

export interface MockHueBridge {
  id: string;
  ip: string;
  name: string;
}

export interface MockDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface MockWorld {
  scenario: ScenarioId;
  /** Bumped on every scenario change. A response that lands under a different
   *  generation than it was issued under is a stale read; see `dispatch.ts`. */
  generation: number;

  serial: {
    ports: MockSerialPort[];
    connectedPort: string | null;
    /** Which health step fails, or `null` for a clean pass. */
    healthFailsAt: string | null;
  };
  wled: {
    devices: MockWledDevice[];
    connectedHost: string | null;
    /** `test_wled_bridge` has three live outcomes, and only one means the
     *  device echoed `live: true` back. Conflating them is the worst lie the
     *  fixtures could tell, because it is the code the UI trusts most. */
    testOutcome: "WLED_TEST_LIVE_CONFIRMED" | "WLED_TEST_SENT_UNCONFIRMED" | "WLED_TEST_SEND_FAILED";
  };
  hue: {
    bridges: MockHueBridge[];
    /** Which bridge the app is working with. `null` means none selected. */
    selectedBridgeId: string | null;
    /** `null` means never paired; a string means an application key exists. */
    appKey: string | null;
    reachable: boolean;
    /** `false` reproduces the expired-key case, which used to read as an empty area. */
    credentialValid: boolean;
    areas: MockHueArea[];
    selectedAreaId: string | null;
    channels: MockHueChannel[];
    streaming: boolean;
    /** Counts down on each pairing poll, reproducing the link-button wait. */
    linkButtonPressesRemaining: number;
    /** `false` makes telemetry report `hue: null` — a third state beyond
     *  streaming and idle, meaning Hue was never active this session. */
    everActive: boolean;
    /**
     * `stop_hue_stream` ran and nothing has started since. Rust's runtime then
     * sits Idle / `HUE_STREAM_STOPPED` whatever the bridge does — the stop
     * cancelled the retry — so no fault is reported until the next start.
     * Absent from a world saved before the field existed, which reads as false.
     */
    stopped: boolean;
    totalReconnects: number;
    /** Drives the `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` readiness sentinel. */
    activeStreamerElsewhere: boolean;
    /**
     * Epoch ms at which that streamer lets go by itself, the way the bridge
     * drops a session an unclean exit left behind; `null` holds it until the
     * toggle clears. Read lazily, so a reload does not restart the clock.
     */
    activeStreamerReleasesAt: number | null;
  };
  displays: MockDisplay[];
  capture: { permissionGranted: boolean };
  lighting: { mode: LightingModeConfig };
  /**
   * Driven directly so the signal readout's own states are reachable: healthy,
   * degraded, stalled, and the absent-versus-zero distinction the readout once
   * got wrong in a Hue-only session.
   */
  telemetry: {
    captureFps: number;
    sendFps: number;
    queueHealth: TelemetryQueueHealth;
    frameLatencyMs: number;
    linkConstrained: boolean;
    linkMaxFps: number;
    lastCaptureErrorCode: string | null;
    lastCaptureErrorAtSecs: number | null;
  };
  /** Every shell-state write fails, reproducing the persist banners. */
  persistFails: boolean;
  /**
   * Command → the status code it should answer with, overriding the fixture's
   * own verdict. This is what a real failure looks like here: a coded status
   * inside a well-formed response, not a rejected promise.
   */
  forcedCodes: Record<string, string>;
  /**
   * Commands forced to reject outright. Kept separate and deliberately small:
   * the IPC layer itself failing, or a Rust panic, is a genuinely different
   * path from a coded failure and the app handles the two differently.
   */
  forcedThrows: string[];
  /** Added to every fixture's delay, to make loading states and races visible. */
  extraLatencyMs: number;
  /**
   * Surfaces that are not device state but decide what the app shows.
   * `viewport` is not a `ShellState` field at all: `resizeToMode` ends in a
   * window call the mock answers with `null`, so compact renders at whatever
   * width the browser tab happens to be and looks roomier than it is. Clamping
   * the root is the only way the 320 px layout is honestly reachable here.
   */
  shell: {
    viewport: "free" | "compact" | "compact-min" | "full" | "full-min";
    notificationPermission: "granted" | "denied" | "prompt";
    autostartEnabled: boolean;
  };
  /**
   * What `shell-state.json` holds at boot.
   *
   * `Partial<ShellState>`, not `Record<string, unknown>`. The loose type let
   * `lastHueBridge` be written as `{ internalipaddress }` — the Hue *discovery
   * endpoint's* field name — while `HueBridgeSummary` declares `ip`, so
   * `toHueStartConfig` returned null and every scenario built on `furnished`
   * rendered Hue as "Not configured" while the status bar said STREAMING. A
   * comment in `handlers/hue.ts` warns about that exact confusion; the comment
   * did not stop it, and the type does.
   *
   * `Partial` because a scenario is allowed to omit a field — that is how a
   * first run is expressed.
   */
  shellState: Partial<ShellState>;
}

const STORAGE_KEY = "lumasync.mock.world";

let world: MockWorld;
const listeners = new Set<() => void>();

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(world));
  } catch {
    // A full or disabled sessionStorage is not worth failing the mock over.
  }
}

export function restoreWorld(): MockWorld | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as MockWorld);
  } catch {
    return null;
  }
}

export function clearStoredWorld(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same.
  }
}

export function getWorld(): MockWorld {
  return world;
}

/** Replaces the world wholesale — a scenario change. Bumps the generation. */
export function setWorld(next: MockWorld, options?: { keepGeneration?: boolean }): void {
  const generation =
    options?.keepGeneration === true ? next.generation : (world?.generation ?? 0) + 1;
  world = { ...next, generation };
  persist();
  notify();
}

/**
 * A narrow edit — one strip removed, one toggle flipped. Does **not** bump the
 * generation: a hand edit is not a new scenario, and treating it as one would
 * fire the stale-response warning on every click.
 *
 * The draft is a deep copy and replaces the world by identity. Mutating in
 * place leaves `getWorld()` returning the same reference, and the panel's
 * `useSyncExternalStore` then bails out of the re-render — the edit lands in
 * the fixtures but the panel keeps showing the old count, which reads as a
 * dead button.
 */
export function mutate(apply: (draft: MockWorld) => void): void {
  const draft = structuredClone(world);
  apply(draft);
  world = draft;
  persist();
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}
