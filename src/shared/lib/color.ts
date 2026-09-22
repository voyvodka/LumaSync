import { clamp } from "./math";

/** RGB triplet, one 0..255 channel each. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const SIX_DIGIT_HEX = /^[0-9a-fA-F]{6}$/;

function hexPair(value: number): string {
  const finite = Number.isFinite(value) ? value : 0;
  return clamp(Math.round(finite), 0, 255).toString(16).padStart(2, "0");
}

/**
 * The one RGB → hex conversion: `#rrggbb`, lowercase, each channel rounded
 * and clamped to 0..255. Lowercase is what is stored (zone border colours,
 * the picker's recent-colours list); display sites uppercase it themselves.
 */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
}

/**
 * Parses six hex digits, with or without a leading `#`, into an RGB triplet;
 * `null` for anything else. `#rgb` short form is rejected on purpose — the
 * picker's hex field marks a draft under six digits as invalid.
 */
export function parseHex(value: string): Rgb | null {
  const digits = value.trim().replace(/^#/, "");
  if (!SIX_DIGIT_HEX.test(digits)) return null;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

/** Canonical `#rrggbb` for a parseable hex string, `null` otherwise. */
export function normalizeHex(value: string): string | null {
  const rgb = parseHex(value);
  return rgb ? rgbToHex(rgb) : null;
}
