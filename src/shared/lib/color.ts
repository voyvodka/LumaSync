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

/**
 * A colour temperature as the white it shows, at full scale — `kelvin_to_rgb_multipliers` ×255 in
 * `led_output/correction.rs`, which Solid's White tab resolves through. Both are pinned by
 * `__tests__/kelvinWhite.golden.json`.
 */
export function kelvinToRgb(kelvin: number): Rgb {
  if (kelvin === 6500) return { r: 255, g: 255, b: 255 };
  const temp = kelvin / 100;
  const unit = (v: number) => Math.max(0, Math.min(1, v / 255));
  const r = temp <= 66 ? 1 : unit(329.698727446 * Math.pow(temp - 60, -0.1332047592));
  const g =
    temp <= 66
      ? unit(99.470802586 * Math.log(temp) - 161.119568166)
      : unit(288.122169528 * Math.pow(temp - 60, -0.0755148492));
  const b = temp >= 66 ? 1 : temp <= 19 ? 0 : unit(138.517731223 * Math.log(temp - 10) - 305.04479273);
  const byte = (m: number) => Math.max(0, Math.min(255, Math.round(m * 255)));
  return { r: byte(r), g: byte(g), b: byte(b) };
}
