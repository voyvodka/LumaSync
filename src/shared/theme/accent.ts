/**
 * Accent Theme
 *
 * Pure helpers that translate the current lighting state into a set of CSS
 * values consumed by the UI through custom properties. No React, no DOM —
 * the `useAccentTheme` hook is responsible for applying the result.
 *
 * Shape rules:
 *  - `color`       → the primary accent tint. Used for slider track, active
 *                    mode button border/ring, preset active outline.
 *  - `colorSoft`   → a low-alpha variant of `color`. Used as the header
 *                    gradient start and any subtle surface wash.
 *  - `gradient`    → a pre-composed linear-gradient string, or `null` when
 *                    the mode should NOT apply a header gradient (Off mode).
 */

export interface AccentTheme {
  /** rgb() string — opaque accent for strokes, rings, slider track. */
  color: string;
  /** rgba() string — ~12% alpha variant for gradient starts / soft washes. */
  colorSoft: string;
  /** Full CSS gradient or null when the mode should not show a gradient. */
  gradient: string | null;
}

/** Ambilight uses a fixed teal accent regardless of the live dominant color. */
export const AMBILIGHT_ACCENT: AccentTheme = {
  color: "rgb(20, 184, 166)",
  colorSoft: "rgba(20, 184, 166, 0.22)",
  gradient:
    "linear-gradient(180deg, rgba(20, 184, 166, 0.28) 0%, rgba(20, 184, 166, 0.14) 35%, rgba(20, 184, 166, 0.06) 65%, transparent 100%)",
};

/** Off mode uses a neutral zinc tint and disables the header gradient. */
export const OFF_ACCENT: AccentTheme = {
  color: "rgb(113, 113, 122)",
  colorSoft: "rgba(113, 113, 122, 0.1)",
  gradient: null,
};

/** Build a solid-mode accent from the current RGB selection. */
export function solidAccent(r: number, g: number, b: number): AccentTheme {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const cr = clamp(r);
  const cg = clamp(g);
  const cb = clamp(b);
  return {
    color: `rgb(${cr}, ${cg}, ${cb})`,
    colorSoft: `rgba(${cr}, ${cg}, ${cb}, 0.22)`,
    // Multi-stop wash so the tint fades in/out smoothly instead of a linear
    // ramp — gives a more painterly, premium "light pool" feeling when the
    // gradient flows over translucent cards.
    gradient: `linear-gradient(180deg, rgba(${cr}, ${cg}, ${cb}, 0.32) 0%, rgba(${cr}, ${cg}, ${cb}, 0.16) 35%, rgba(${cr}, ${cg}, ${cb}, 0.06) 65%, transparent 100%)`,
  };
}
