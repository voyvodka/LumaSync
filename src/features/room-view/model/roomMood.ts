// What the running mode does to the 3D room: whether its lamps are lit, in what colour and how
// bright, and the sky behind the room. Off leaves the room in the night; Solid lights every lamp in
// its colour, an effect in its palette's middle; Ambilight dims the sky to a cinema violet, the
// lamps keeping their warm placeholder until the live colours reach the view. The sky is a top
// colour fading down to the night.
import { type LightingModeConfig, LIGHTING_MODE_KIND } from "@/shared/contracts/mode";
import { kelvinToRgb } from "@/shared/lib/color";
import { paletteOf, paletteStops } from "@/features/mode/model/effectSwatch";

import { LAMP_COLOURS } from "./lampColours";

export interface RoomMood {
  /** 0 dark, 1 at full: the lamps' level. */
  level: number;
  /** The lamps' colour while lit. */
  lamp: number;
  /** The sky's top, and the colour it fades through before the night. */
  sky: { top: number; mid: number };
}

const WARM = LAMP_COLOURS[0];
const SKY_WARM = { top: 0x6e5a4c, mid: 0x2a211e };
const SKY_CINEMA = { top: 0x2a2052, mid: 0x130e2b };
const SKY_NIGHT = { top: 0x121d3d, mid: 0x0a1024 };
/** The floor a dim lamp keeps: at 1% a Hue light still glows, it does not read as off. */
const LEVEL_FLOOR = 0.12;

function rgb(r: number, g: number, b: number): number {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return rgb(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** A lamp colour's sky: the colour itself, darkened into the night. */
function skyOf(colour: number): RoomMood["sky"] {
  return { top: mix(colour, 0x0b0b12, 0.62), mid: mix(colour, 0x07070c, 0.86) };
}

const level = (brightness: number | undefined) => LEVEL_FLOOR + (1 - LEVEL_FLOOR) * Math.min(Math.max(brightness ?? 1, 0), 1);

/** `null` — no running mode known (a test, a window without one) — reads as lamps lit warm. */
export function roomMood(mode: LightingModeConfig | null): RoomMood {
  if (!mode) return { level: 1, lamp: WARM, sky: SKY_WARM };
  switch (mode.kind) {
    case LIGHTING_MODE_KIND.OFF:
      return { level: 0, lamp: WARM, sky: SKY_NIGHT };
    case LIGHTING_MODE_KIND.SOLID: {
      const solid = mode.solid;
      if (!solid) return { level: 1, lamp: WARM, sky: SKY_WARM };
      const c = solid.kelvin != null ? kelvinToRgb(solid.kelvin) : solid;
      const lamp = rgb(c.r, c.g, c.b);
      return { level: level(solid.brightness), lamp, sky: skyOf(lamp) };
    }
    case LIGHTING_MODE_KIND.EFFECT: {
      const effect = mode.effect;
      if (!effect) return { level: 1, lamp: WARM, sky: SKY_WARM };
      // An effect moves through its palette; until the live colours reach the view, the lamps hold
      // the palette's middle.
      const stops = paletteStops(paletteOf(effect), effect);
      const middle = stops[Math.floor(stops.length / 2)];
      const lamp = middle ? Number.parseInt(middle.slice(1), 16) : WARM;
      return { level: level(effect.brightness), lamp, sky: skyOf(lamp) };
    }
    default:
      return { level: level(mode.ambilight?.brightness), lamp: WARM, sky: SKY_CINEMA };
  }
}

export function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}
