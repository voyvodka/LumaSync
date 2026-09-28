import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { StartLedTestPatternPayload } from "@/shared/contracts/preview";
import { createStore, useStoreSelector } from "@/shared/lib/store";

import { startLedTestPattern, stopLedTestPattern } from "@/features/preview/previewApi";

/** How long a flash holds the strip lit: long enough to look up and see it. */
export const FLASH_MS = 1500;

/**
 * The layout a flash uses for a strip with none yet: sixty LEDs along one edge. Without a layout
 * the test pattern runs on the preview only and the strip never lights, which is the one thing a
 * new strip's flash is for.
 */
export const FLASH_FALLBACK_LAYOUT: LedCalibrationConfig = {
  counts: { top: 60, right: 0, bottom: 0, left: 0 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "subtle",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 60,
};

export type FlashOutcome = "lit" | "notSent" | "failed";

export interface FlashDeps {
  start: (payload: StartLedTestPatternPayload) => ReturnType<typeof startLedTestPattern>;
  stop: () => ReturnType<typeof stopLedTestPattern>;
  wait: (ms: number) => Promise<void>;
}

const defaultDeps: FlashDeps = {
  start: (payload) => startLedTestPattern(payload),
  stop: () => stopLedTestPattern(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Lights the strip white for a moment through the test pattern, which takes over from a running
 * mode and gives it back on stop. `notSent` when the pattern ran on the preview only: nothing
 * reached the strip, so asking whether it lit would be asking about nothing.
 */
export async function flashStrip(layout: LedCalibrationConfig | undefined, deps: FlashDeps = defaultDeps): Promise<FlashOutcome> {
  const started = await deps.start({
    pattern: { kind: "solid", r: 255, g: 255, b: 255 },
    brightness: 0.5,
    targets: ["usb"],
    ledCalibration: layout ?? FLASH_FALLBACK_LAYOUT,
  });
  if (!started.active) return "failed";
  await deps.wait(FLASH_MS);
  await deps.stop();
  return started.previewOnly ? "notSent" : "lit";
}

/** Strips the user said did not light, until one lights. For the session: a restart asks again. */
const unlitStore = createStore<ReadonlySet<string>>(new Set());

export function markStripLit(stripId: string, lit: boolean): void {
  const current = unlitStore.get();
  if (current.has(stripId) === !lit) return;
  const next = new Set(current);
  if (lit) next.delete(stripId);
  else next.add(stripId);
  unlitStore.set(next);
}

export function useStripUnlit(stripId: string): boolean {
  return useStoreSelector(unlitStore, (unlit) => unlit.has(stripId));
}
