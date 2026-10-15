// A fixed count, spares dark: the light count is part of the shader programs, and a count that
// followed the lamps recompiled the room on every added lamp.
import { Color, type Light, type Object3D, PointLight, SpotLight } from "three";

import type { Lamp } from "./glow";

export const LAMP_LIGHTS = 6;
/** One-sided fixtures (a Play bar, an Iris) throw a cone; past these they fall back to a point. */
export const LAMP_SPOTS = 3;
// Cube shadow maps, redrawn only when a wall cuts: the cost is memory.
const SHADOW_LAMPS = 3;
const SHADOW_MAP = 256;
const INTENSITY = 7;
// A cone puts all of a lamp's light on one side: the same intensity read twice as bright there.
const SPOT_INTENSITY = 9;
const MIN_LIGHT_Y = 0.3;
/** How far behind its lit part a cone starts, so the fixture's own body does not catch it. */
const SPOT_SETBACK = 0.04;

export interface LampLights {
  /** The lights and the spots' targets, to add to the scene. */
  objects: Object3D[];
  /** Every lit lamp in one colour (or each its own, `null`) at `level`, 0 dark to 1 full. */
  paint(lampColour: number | null, level: number): void;
}

export function lampLights(lamps: Lamp[], roomReach: number, shadows: boolean): LampLights {
  const inside = lamps.filter((lamp) => !lamp.outside);
  const coned = inside.filter((lamp) => lamp.beam).slice(0, LAMP_SPOTS);
  const round = inside.filter((lamp) => !coned.includes(lamp)).slice(0, LAMP_LIGHTS);
  for (const lamp of [...coned, ...round]) lamp.litByLight = true;
  const colour = new Color();

  const points = Array.from({ length: LAMP_LIGHTS }, (_, i) => {
    const lamp = round[i];
    const light = new PointLight(0xffffff, 0, roomReach, 2);
    light.castShadow = shadows && i < SHADOW_LAMPS && lamp !== undefined;
    if (light.castShadow) {
      light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
      light.shadow.radius = 8;
      light.shadow.bias = -0.002;
      light.shadow.camera.near = 0.05;
      // At full strength a lamp's shadow cut black wedges up the walls.
      light.shadow.intensity = 0.4;
    }
    if (lamp) {
      // Just under the lit part, so a ceiling light's own canopy does not shadow the whole room; never
      // at the floor, where it grazed the planks into bright seams.
      light.position.set(lamp.at.x, Math.max(lamp.at.y - Math.max(lamp.radii[1], 0.02) - 0.03, MIN_LIGHT_Y), lamp.at.z);
    } else {
      light.position.set(0, -10, 0);
    }
    return light;
  });

  const spots = Array.from({ length: LAMP_SPOTS }, (_, i) => {
    const lamp = coned[i];
    const light = new SpotLight(0xffffff, 0, roomReach, lamp?.beam?.spread ?? 1, 1, 2);
    if (lamp?.beam) {
      const { aim } = lamp.beam;
      light.position.set(lamp.at.x - aim.x * SPOT_SETBACK, lamp.at.y - aim.y * SPOT_SETBACK, lamp.at.z - aim.z * SPOT_SETBACK);
      light.target.position.set(lamp.at.x + aim.x, lamp.at.y + aim.y, lamp.at.z + aim.z);
    } else {
      light.position.set(0, -10, 0);
      light.target.position.set(0, -11, 0);
    }
    return light;
  });

  const paint = (lampColour: number | null, level: number) => {
    const light = (target: Light, lamp: Lamp, intensity: number) => {
      target.color.copy(colour.set(lampColour ?? lamp.color));
      target.intensity = intensity * level;
    };
    round.forEach((lamp, i) => points[i] && light(points[i], lamp, INTENSITY));
    coned.forEach((lamp, i) => spots[i] && light(spots[i], lamp, SPOT_INTENSITY));
  };
  paint(null, 1);
  return { objects: [...points, ...spots, ...spots.map((spot) => spot.target)], paint };
}
