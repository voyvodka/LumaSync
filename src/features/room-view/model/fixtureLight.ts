// Sizes in metres, read off Philips Hue product pages (2026-10-20). Philips states no angle for its
// decorative lamps, so a spread or tilt is recalled unless its line says otherwise: correct it here.

import type { LampFamily } from "./lampFamily";

export interface FixtureThrow {
  /** Half-angle, radians. */
  spread: number;
  /** Above the level toward what it faces, radians: π/2 straight up, −π/2 straight down. */
  tilt: number;
}

export interface FixtureLight {
  /** Absent ⇒ it lights all round. */
  throw?: FixtureThrow;
  back?: FixtureThrow;
  length?: number;
  diameter?: number;
  /** The lit part's height, where it differs from its width. */
  height?: number;
}

const DOWN = -Math.PI / 2;

/** `downlight` is a spot set in the ceiling, which throws down instead of up its wall; `hungSpot` one
 *  too high to stand, hung from the ceiling and aimed down the wall it faces. */
export const FIXTURE_LIGHT: Readonly<Record<LampFamily | "downlight" | "hungSpot", FixtureLight>> = {
  playBar: { throw: { spread: 1.05, tilt: 0 }, length: 0.253 },
  signe: { throw: { spread: 1.1, tilt: 0 }, length: 1.37 },
  iris: { throw: { spread: 0.8, tilt: 0.6 }, diameter: 0.2 },
  bloom: { throw: { spread: 0.75, tilt: 0.75 }, diameter: 0.13 },
  go: { diameter: 0.15 },
  pendant: { throw: { spread: 1.05, tilt: DOWN }, diameter: 0.475 },
  ceiling: { throw: { spread: 1.2, tilt: DOWN }, diameter: 0.425 },
  // Fugato and Runner heads are 40°, as is a Centura set in the ceiling.
  spot: { throw: { spread: 0.35, tilt: 0.5 } },
  downlight: { throw: { spread: 0.35, tilt: DOWN } },
  hungSpot: { throw: { spread: 0.35, tilt: -0.6 } },
  // An Appear: sharp wedges up and down from a 24 cm box.
  wall: { throw: { spread: 0.35, tilt: 1.4 }, back: { spread: 0.35, tilt: -1.4 }, height: 0.24, diameter: 0.117 },
  // Stated 120°, but the map does not know which way a strip is stuck, so it lights all round.
  lightstrip: { length: 2 },
  // The large tube; the compact one is 87.7 cm.
  tube: { length: 1.377 },
  floorLamp: {},
  tableLamp: {},
  bulb: {},
};
