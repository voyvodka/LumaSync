// Rust reads Hue availability from the live stream, so a test started with the
// mode off goes preview-only on a good bridge (`docs/architecture/hue.md`).

import { HUE_RUNTIME_STATUS, type HueRuntimeTarget } from "@/shared/contracts/hue";
import { isHueStartCodeOk, toHueStartConfig } from "@/features/hue/model/hueStartConfig";
import { shellStore } from "@/features/persistence/shellStore";
import { startHue, stopHue } from "@/features/mode/modeApi";

type LeaseState =
  /** Nothing attempted for the current run. */
  | "idle"
  /** We opened the stream, so we owe it a stop when the test ends. */
  | "held"
  /** Either it was already streaming or it refused; both mean hands off. */
  | "not-ours";

let state: LeaseState = "idle";

// Starts arrive throttled at ~4 Hz while a colour is dragged, and a stop can
// land between two of them. Serialising is what stops a release running against
// a half-finished acquire and leaving `state` describing neither.
let chain: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): Promise<void> {
  chain = chain.then(work, work);
  return chain;
}

export interface HueTestLeaseDeps {
  load?: typeof shellStore.load;
  start?: typeof startHue;
  stop?: typeof stopHue;
}

/**
 * Bring the Hue stream up for a test run that targets it. Idempotent across the
 * repeated starts a live pattern issues: only the first attempt of a run talks
 * to the bridge.
 */
export function acquireHueForTest(
  targets: readonly HueRuntimeTarget[] | undefined,
  deps: HueTestLeaseDeps = {},
): Promise<void> {
  const load = deps.load ?? shellStore.load;
  const start = deps.start ?? startHue;

  return enqueue(async () => {
    if (state !== "idle") return;
    if (!targets?.includes("hue")) return;

    let config: ReturnType<typeof toHueStartConfig> = null;
    try {
      config = toHueStartConfig(await load());
    } catch (error) {
      console.error("[LumaSync] hueTestLease could not read the start config:", error);
    }
    if (!config) {
      state = "not-ours";
      return;
    }

    try {
      const result = await start(config);
      // `START_NOOP_ALREADY_ACTIVE` means something else owns the stream — a
      // live mode, or the other webview's test. Stopping it on our way out
      // would switch off lights we never turned on.
      state =
        isHueStartCodeOk(result.status.code) &&
        result.status.code !== HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE
          ? "held"
          : "not-ours";
      if (!isHueStartCodeOk(result.status.code)) {
        console.warn(
          `[LumaSync] hueTestLease start refused (${result.status.code}); the test runs preview-only`,
        );
      }
    } catch (error) {
      console.error("[LumaSync] hueTestLease start threw:", error);
      state = "not-ours";
    }
  });
}

/** Hand the stream back if this lease opened it. Safe to call unconditionally. */
export function releaseHueAfterTest(deps: HueTestLeaseDeps = {}): Promise<void> {
  const stop = deps.stop ?? stopHue;

  return enqueue(async () => {
    const held = state === "held";
    state = "idle";
    if (!held) return;
    try {
      await stop();
    } catch (error) {
      console.error("[LumaSync] hueTestLease release threw:", error);
    }
  });
}

/** Test seam — the lease is module state, so a suite has to be able to rewind it. */
export function __resetHueTestLease(): void {
  state = "idle";
  chain = Promise.resolve();
}
