/**
 * The half of the backend that is not `invoke`.
 *
 * Roughly a third of what the app reacts to never arrives as a command result.
 * The digital twin, the tray menu, the update progress bar and
 * the cross-window mode sync are all driven by Tauri events pushed from Rust,
 * and until this file existed the mock answered every `invoke` faithfully and
 * then left all of them dead. The effect was worse than an obvious gap: the
 * signal readout rendered zeros in every scenario, which is indistinguishable
 * from the bug the "Hue only" scenario was built to reproduce.
 *
 * **One emit path, both runtimes.** `emit()` from `@tauri-apps/api/event` goes
 * out as `invoke("plugin:event|emit")`, and that command is deliberately absent
 * from `pluginHandlers` — so in the browser `mockIPC`'s own event registry
 * answers it, and under `tauri:mock` it reaches Rust, which broadcasts back to
 * the webview. Neither branch is special-cased here; if the capability set ever
 * stops allowing `event:allow-emit`, the failure surfaces through
 * `reportEmitFailure` rather than as silence.
 *
 * **Frames are derived from the world, not from constants.** A stream of 164
 * LEDs against a world calibrated for 60 would make the twin overlay look
 * correct while hiding every off-by-one in the strip-path mapping. The
 * generator reads the live calibration and channel list on each frame, so
 * editing either in the panel is visible in the next one.
 */

import { emit } from "@tauri-apps/api/event";

import { LIGHTING_EVENTS } from "../src/shared/contracts/lightingRuntime";
import type { LightingModeChangedPayload } from "../src/shared/contracts/mode";
import {
  PREVIEW_EVENTS,
  type EdgeSignalPayload,
  type LedPreviewStatus,
  type LedTestPatternKind,
} from "../src/shared/contracts/preview";
import { UPDATER_EVENTS, type UpdateDownloadProgress } from "../src/shared/contracts/updater";
import {
  LINK_MAX_FPS_ABSENT,
  TELEMETRY_EVENTS,
  runtimeHealthFromSnapshot,
} from "../src/shared/contracts/telemetry";
import { SHELL_EVENTS, TRAY_EVENTS } from "../src/shared/contracts/shell";
import { getWorld } from "./state";

/** ~10 Hz. The real worker feeds an open twin at ~30 Hz; the mock does not need to. */
export const EDGE_SIGNAL_INTERVAL_MS = 100;

type Rgb = [number, number, number];

/**
 * The tray's preview item, the window close intercept, and the startup-state
 * echo — re-exported so `DevPanel.tsx` has one import path for every event it
 * can fire, `SHELL_EVENTS`/`TRAY_EVENTS` from `src/shared/contracts/shell`
 * included.
 *
 * These have no `invoke` at all — the tray lives in Rust and there is no tray
 * in a browser tab, so before this list they had no reachable trigger anywhere
 * in the mock. The tray's three lighting items are not events: Rust runs them
 * itself, and the panel sends the request they make.
 */
export { SHELL_EVENTS, TRAY_EVENTS };

function reportEmitFailure(event: string, err: unknown): void {
  console.error(
    `[LumaSync][mock] emitting "${event}" failed: ${String(err)}. In the browser this means mockIPC was installed without \`shouldMockEvents\`; under \`tauri:mock\` it usually means the capability set does not grant \`event:allow-emit\`.`,
  );
}

export async function emitMockEvent(event: string, payload?: unknown): Promise<void> {
  try {
    await emit(event, payload);
  } catch (err) {
    reportEmitFailure(event, err);
  }
}

// --- Frame synthesis -------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6] as Rgb;
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * How many LEDs the calibration says the strip has.
 *
 * Falls back to a count rather than to zero: an empty `leds` array is a valid
 * payload the twin renders as "nothing", so a missing calibration would look
 * like a working stream of no pixels instead of an unconfigured strip.
 */
function calibratedLedCount(): number {
  const calibration = getWorld().shellState.ledCalibration as { totalLeds?: number } | undefined;
  const total = calibration?.totalLeds;
  return typeof total === "number" && total > 0 ? total : 60;
}

type ProbeSlot = 0 | 1 | 2;

function pixelAt(
  pattern: LedTestPatternKind,
  index: number,
  count: number,
  frame: number,
  slot: ProbeSlot,
): Rgb {
  const position = count <= 1 ? 0 : index / (count - 1);
  switch (pattern) {
    case "solid":
      return [251, 191, 36];
    case "chase": {
      // A five-LED comet so direction and wrap are both visible; a single lit
      // pixel reads as a rendering glitch at any real strip length.
      const head = frame % count;
      const distance = (index - head + count) % count;
      const falloff = distance < 5 ? 1 - distance / 5 : 0;
      return [Math.round(251 * falloff), Math.round(191 * falloff), Math.round(36 * falloff)];
    }
    case "rainbow":
      return hsvToRgb((position + frame / 60) % 1, 1, 1);
    case "spiral":
      return hsvToRgb((position * 3 + frame / 30) % 1, 1, 0.5 + 0.5 * Math.sin(frame / 10));
    case "gamut":
      // Three flat bands — the case where a gamut-clipping bug is legible,
      // which a continuous sweep hides.
      return position < 1 / 3 ? [255, 0, 0] : position < 2 / 3 ? [0, 255, 0] : [0, 0, 255];
    case "channelProbe":
      // The whole strip in one primary, as the real probe renders it.
      return slot === 0 ? [255, 0, 0] : slot === 1 ? [0, 255, 0] : [0, 0, 255];
  }
}

export function buildEdgeSignalFrame(
  pattern: LedTestPatternKind,
  frame: number,
  source: "test" | "live",
  slot: ProbeSlot = 0,
): EdgeSignalPayload {
  const world = getWorld();
  const ledCount = calibratedLedCount();
  return {
    leds: Array.from({ length: ledCount }, (_, i) => pixelAt(pattern, i, ledCount, frame, slot)),
    ledCount,
    hueChannels: world.hue.channels.map((_, i) =>
      pixelAt(pattern, i, Math.max(world.hue.channels.length, 1), frame, slot),
    ),
    source,
    pattern: source === "test" ? pattern : undefined,
    seq: frame,
    displayId: world.displays[0]?.id,
  };
}

// --- The stream ------------------------------------------------------------

export interface EdgeSignalStreamState {
  running: boolean;
  pattern: LedTestPatternKind;
  /** Wire slot a `channelProbe` stream lights; ignored by every other pattern. */
  probeSlot: ProbeSlot;
  source: "test" | "live";
  /** Frames emitted since the stream last started. Drives `seq`. */
  frame: number;
  /**
   * Emit only every Nth tick while claiming the full rate. Reproduces a worker
   * that has fallen behind, which is the state the twin's drop detection and
   * the signal readout's staleness handling both exist for and which nothing
   * else here could produce.
   */
  dropEveryNthFrame: number;
}

let stream: EdgeSignalStreamState = {
  running: false,
  pattern: "rainbow",
  probeSlot: 0,
  source: "live",
  frame: 0,
  dropEveryNthFrame: 0,
};

let timer: ReturnType<typeof setInterval> | null = null;
const streamListeners = new Set<() => void>();

export function getEdgeSignalStream(): EdgeSignalStreamState {
  return stream;
}

export function subscribeToEdgeSignalStream(listener: () => void): () => void {
  streamListeners.add(listener);
  return () => streamListeners.delete(listener);
}

function setStream(next: Partial<EdgeSignalStreamState>): void {
  stream = { ...stream, ...next };
  for (const listener of streamListeners) listener();
}

function tick(): void {
  const frame = stream.frame + 1;
  // The counter advances on a dropped frame too. A stream that renumbered
  // around its own drops would look perfectly sequential to the twin, which is
  // exactly the signal drop detection reads.
  setStream({ frame });
  const drop = stream.dropEveryNthFrame;
  if (drop > 1 && frame % drop === 0) return;
  void emitMockEvent(
    PREVIEW_EVENTS.EDGE_SIGNAL,
    buildEdgeSignalFrame(stream.pattern, frame, stream.source, stream.probeSlot),
  );
}

export function startEdgeSignalStream(
  options?: Partial<
    Pick<EdgeSignalStreamState, "pattern" | "probeSlot" | "source" | "dropEveryNthFrame">
  >,
): void {
  stopEdgeSignalStream();
  setStream({ ...options, running: true, frame: 0 });
  timer = setInterval(tick, EDGE_SIGNAL_INTERVAL_MS);
  void emitPreviewState();
}

export function stopEdgeSignalStream(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (stream.running) {
    setStream({ running: false });
    void emitPreviewState();
  }
}

// --- One-shot emitters -----------------------------------------------------

/**
 * Derived from the stream rather than stored separately, so the preview status
 * and the frames the app is receiving cannot disagree — which they would if the
 * panel had a second switch for each.
 */
export function currentPreviewStatus(): LedPreviewStatus {
  const running = stream.running;
  return {
    testActive: running && stream.source === "test",
    source: running ? stream.source : "idle",
    activePattern:
      running && stream.source === "test"
        ? patternPayload(stream.pattern, stream.probeSlot)
        : undefined,
    twinDisplays: [],
    popupVisible: false,
    liveTwinSupported: true,
  };
}

function patternPayload(
  kind: LedTestPatternKind,
  slot: ProbeSlot,
): NonNullable<LedPreviewStatus["activePattern"]> {
  if (kind === "solid" || kind === "chase") return { kind, r: 251, g: 191, b: 36 };
  if (kind === "channelProbe") return { kind, slot };
  return { kind };
}

export async function emitPreviewState(): Promise<void> {
  await emitMockEvent(PREVIEW_EVENTS.STATE_CHANGED, currentPreviewStatus());
}

/**
 * The worker's push of the stall and link budget. The real one fires when they
 * change; here the panel's "Signal state" pick is the change. Uses the same
 * absent-link rule as the `get_runtime_telemetry` fixture.
 */
export async function emitRuntimeHealth(): Promise<void> {
  const w = getWorld();
  const usb = {
    ...w.telemetry,
    linkMaxFps: w.serial.connectedPort !== null ? w.telemetry.linkMaxFps : LINK_MAX_FPS_ABSENT,
  };
  await emitMockEvent(TELEMETRY_EVENTS.HEALTH_CHANGED, runtimeHealthFromSnapshot(usb));
}

export async function emitLightingModeChanged(): Promise<void> {
  const mode = getWorld().lighting.mode;
  const payload: LightingModeChangedPayload = { config: mode, active: mode.kind !== "off" };
  await emitMockEvent(LIGHTING_EVENTS.MODE_CHANGED, payload);
}

/**
 * A download that takes a few seconds and ends with `finished: true`.
 *
 * The real one runs over the network, so the two states worth reaching from
 * here are "a bar that moves" and "a server that sent no Content-Length" —
 * the second renders an indeterminate bar and used to be untestable without a
 * proxy.
 */
export async function emitUpdateDownload(options?: { withTotal?: boolean }): Promise<void> {
  const totalBytes = 42_000_000;
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) {
    const payload: UpdateDownloadProgress = {
      downloadedBytes: Math.round((totalBytes / steps) * i),
      totalBytes: options?.withTotal === false ? null : totalBytes,
      finished: i === steps,
    };
    await emitMockEvent(UPDATER_EVENTS.DOWNLOAD_PROGRESS, payload);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
