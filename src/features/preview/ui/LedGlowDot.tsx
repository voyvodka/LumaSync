/**
 * LedGlowDot — a single per-LED glow on the digital-twin overlay.
 *
 * Positioned absolutely by its parent via normalized 0..1 coordinates. The
 * glow is a radial gradient from the live LED colour outward to transparent,
 * set entirely through inline style so it can update at the ~10 Hz stream
 * cadence. There is deliberately NO CSS color transition (see `.lm-twin-dot`)
 * — a transition would lag the dot behind the stream and smear fast patterns
 * like `chase`. The element is `aria-hidden` because the overlay is a purely
 * decorative ambient mirror of the physical strip.
 */

import { memo } from "react";

import { packedToCss, type PackedLedColor } from "../ledColor";

export interface LedGlowDotProps {
  /** Normalized 0..1 X across the viewport. */
  x: number;
  /** Normalized 0..1 Y across the viewport. */
  y: number;
  /**
   * Live colour as a packed `0xRRGGBB` integer — a primitive so the `memo`
   * shallow compare bails out on unchanged dots (see `../ledColor`).
   */
  color: PackedLedColor;
  /** Dot diameter in px. */
  size: number;
}

export const LedGlowDot = memo(function LedGlowDot({ x, y, color, size }: LedGlowDotProps) {
  return (
    <span
      className="lm-twin-dot"
      aria-hidden="true"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${size}px`,
        height: `${size}px`,
        background: `radial-gradient(circle, ${packedToCss(color, 0.95)} 0%, ${packedToCss(color, 0.55)} 36%, ${packedToCss(color, 0)} 72%)`,
      }}
    />
  );
});
