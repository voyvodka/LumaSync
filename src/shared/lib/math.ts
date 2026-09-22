/** Restricts a number to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Rounds to `decimals` places and drops trailing zeros. Room-map numbers cross
 * the IPC boundary as f32, so 2.1 arrives as 2.0999999046325684 — and a number
 * input or `aria-valuenow` shows and reads out exactly that.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
