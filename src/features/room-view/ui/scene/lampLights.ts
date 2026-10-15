// Real light from the lamps. The glow's pools say where light lands; these light what is there —
// the sofa's front, the wall behind a floor lamp, the side of the table facing it — and throw the
// shadows a lamp-lit room has. A fixed number of them, the unused ones dark, so adding a lamp to
// the map does not change the shader programs and stall the view while the room recompiles.
import { Color, PointLight } from "three";

import type { Lamp } from "./glow";

export const LAMP_LIGHTS = 6;
/** Lamps whose light casts a shadow. Each is a cube map drawn only when the shadows are, which is
 *  when the walls cut, so the cost is memory: kept small. */
const SHADOW_LAMPS = 3;
const SHADOW_MAP = 256;
/** Candela of a lamp at full: a room this size reads lamp-lit without the walls burning out. */
const INTENSITY = 7;

export interface LampLights {
  lights: PointLight[];
  /** Every lit lamp in one colour (or each its own, `null`) at `level`, 0 dark to 1 full. */
  paint(lampColour: number | null, level: number): void;
}

/** Gives the first lamps in the room a real light each and marks them `litByLight`. */
export function lampLights(lamps: Lamp[], roomReach: number, shadows: boolean): LampLights {
  const lit = lamps.filter((lamp) => !lamp.outside).slice(0, LAMP_LIGHTS);
  for (const lamp of lit) lamp.litByLight = true;
  const colour = new Color();
  const lights = Array.from({ length: LAMP_LIGHTS }, (_, i) => {
    const lamp = lit[i];
    const light = new PointLight(0xffffff, 0, roomReach, 2);
    light.castShadow = shadows && i < SHADOW_LAMPS;
    if (light.castShadow) {
      light.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
      light.shadow.radius = 8;
      light.shadow.bias = -0.002;
      light.shadow.camera.near = 0.05;
      // A lamp's shadow is filled by the room's bounce; at full strength it cut black wedges.
      light.shadow.intensity = 0.7;
    }
    if (lamp) {
      // Just under the lit part, so a ceiling light's own canopy does not shadow the whole room.
      light.position.set(lamp.at.x, lamp.at.y - Math.max(lamp.radii[1], 0.02) - 0.03, lamp.at.z);
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
