// How each fixture lets its light out: the lit part's size and the throw's spread and tilt, one
// place for all of them. Free of three.js.
//
// Sizes marked checked were read off Philips Hue product pages or retailer listings (2026-10-20).
// Every spread and tilt is recalled, not read off a spec sheet: correct them here.

import type { LampFamily } from "./lampFamily";

export interface FixtureThrow {
  /** Half-angle, radians. */
  spread: number;
  /** Above the level toward what it faces, radians: π/2 straight up, −π/2 straight down. */
  tilt: number;
}

export interface FixtureLight {
  /** One-sided: its main throw. Absent ⇒ it lights all round. */
  throw?: FixtureThrow;
  /** A second throw the other way, as a wall washer lights up and down the wall. */
  back?: FixtureThrow;
  /** The lit part's length for a line source, metres. */
  length?: number;
  /** The lit part's diameter for a round one, metres. */
  diameter?: number;
  /** Which of the values above were checked against a product listing. */
  checked: readonly ("length" | "diameter")[];
}

const DOWN = -Math.PI / 2;

/** A spot set in the ceiling has its own entry, since the same fixture throws another way there. */
export const FIXTURE_LIGHT: Readonly<Record<LampFamily | "downlight", FixtureLight>> = {
  // 25.3 cm tall; its back lights the wall behind it, level.
  playBar: { throw: { spread: 1.05, tilt: 0 }, length: 0.253, checked: ["length"] },
  // 145.8 cm tall; the side toward the wall is lit its whole height.
  signe: { throw: { spread: 1.1, tilt: 0 }, length: 1.37, checked: ["length"] },
  iris: { throw: { spread: 0.8, tilt: 0.6 }, diameter: 0.2, checked: ["diameter"] },
  bloom: { throw: { spread: 0.75, tilt: 0.75 }, diameter: 0.13, checked: ["diameter"] },
  go: { diameter: 0.15, checked: ["diameter"] },
  pendant: { throw: { spread: 1.05, tilt: DOWN }, checked: [] },
  ceiling: { throw: { spread: 1.2, tilt: DOWN }, checked: [] },
  // Set in the ceiling it throws down; standing or on a wall it is aimed up the wall it faces.
  spot: { throw: { spread: 0.35, tilt: 0.5 }, checked: [] },
  downlight: { throw: { spread: 0.42, tilt: DOWN }, checked: [] },
  wall: { throw: { spread: 0.7, tilt: 1.4 }, back: { spread: 0.7, tilt: -1.4 }, checked: [] },
  lightstrip: { length: 2, checked: [] },
  // The large Play gradient tube; the compact one is about 75 cm.
  tube: { length: 1.25, checked: ["length"] },
  floorLamp: { checked: [] },
  tableLamp: { checked: [] },
  bulb: { checked: [] },
};
