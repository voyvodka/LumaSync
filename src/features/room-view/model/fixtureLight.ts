// Sizes in metres. Every spread and tilt is recalled, not read off a spec sheet: correct them here.

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
  /** Read off a Philips Hue product page or retailer listing (2026-10-20). */
  checked: readonly ("length" | "diameter")[];
}

const DOWN = -Math.PI / 2;

/** `downlight` is a spot set in the ceiling, which throws down instead of up its wall. */
export const FIXTURE_LIGHT: Readonly<Record<LampFamily | "downlight", FixtureLight>> = {
  playBar: { throw: { spread: 1.05, tilt: 0 }, length: 0.253, checked: ["length"] },
  signe: { throw: { spread: 1.1, tilt: 0 }, length: 1.37, checked: ["length"] },
  iris: { throw: { spread: 0.8, tilt: 0.6 }, diameter: 0.2, checked: ["diameter"] },
  bloom: { throw: { spread: 0.75, tilt: 0.75 }, diameter: 0.13, checked: ["diameter"] },
  go: { diameter: 0.15, checked: ["diameter"] },
  pendant: { throw: { spread: 1.05, tilt: DOWN }, checked: [] },
  ceiling: { throw: { spread: 1.2, tilt: DOWN }, checked: [] },
  spot: { throw: { spread: 0.35, tilt: 0.5 }, checked: [] },
  downlight: { throw: { spread: 0.42, tilt: DOWN }, checked: [] },
  wall: { throw: { spread: 0.7, tilt: 1.4 }, back: { spread: 0.7, tilt: -1.4 }, checked: [] },
  lightstrip: { length: 2, checked: [] },
  // The large tube; the compact one is about 75 cm.
  tube: { length: 1.25, checked: ["length"] },
  floorLamp: { checked: [] },
  tableLamp: { checked: [] },
  bulb: { checked: [] },
};
