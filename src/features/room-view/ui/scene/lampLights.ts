// A fixed count, spares dark: the light count is part of the shader programs, and a count that
// followed the lamps recompiled the room on every added lamp.
import { Color, PointLight } from "three";

import type { Lamp } from "./glow";

export const LAMP_LIGHTS = 6;
// Cube shadow maps, redrawn only when a wall cuts: the cost is memory.
const SHADOW_LAMPS = 3;
const SHADOW_MAP = 256;
const INTENSITY = 7;
const MIN_LIGHT_Y = 0.3;

export interface LampLights {
  lights: PointLight[];
  /** Every lit lamp in one colour (or each its own, `null`) at `level`, 0 dark to 1 full. */
  paint(lampColour: number | null, level: number): void;
}

export function lampLights(lamps: Lamp[], roomReach: number, shadows: boolean): LampLights {
  const lit = lamps.filter((lamp) => !lamp.outside).slice(0, LAMP_LIGHTS);
  for (const lamp of lit) lamp.litByLight = true;
  const colour = new Color();
  const lights = Array.from({ length: LAMP_LIGHTS }, (_, i) => {
    const lamp = lit[i];
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
  const paint = (lampColour: number | null, level: number) => {
    lit.forEach((lamp, i) => {
      const light = lights[i];
      if (!light) return;
      light.color.copy(colour.set(lampColour ?? lamp.color));
      light.intensity = INTENSITY * level;
    });
  };
  paint(null, 1);
  return { lights, paint };
}
