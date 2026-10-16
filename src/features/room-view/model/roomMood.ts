// Ambilight and an effect's motion are placeholders here until the live colours reach the view.
import { DEFAULT_EFFECT, type LightingModeConfig, LIGHTING_MODE_KIND } from "@/shared/contracts/mode";
import { ROOM_AMBIENT_DEFAULT } from "@/shared/contracts/shell";
import { kelvinToRgb } from "@/shared/lib/color";
import { paletteOf, paletteStops } from "@/features/mode/model/effectSwatch";

import { LAMP_COLOURS } from "./lampColours";

export interface MoodLevels {
  /** The lamps, 0 dark to 1 full. */
  level: number;
  /** The room's own light, 0 night to 1 lamp-lit: a screen or an effect lights a dark room. */
  ambient: number;
  /** The LED strips and the screen's backlight: under Ambilight they carry the picture at full. */
  strip: number;
  /** The room with no lamp on, 0 night to 1 day: the Room settings "Ambient light". */
  daylight: number;
}

export const MOOD_LEVELS = ["level", "ambient", "strip", "daylight"] as const satisfies ReadonlyArray<keyof MoodLevels>;

export interface RoomMood extends MoodLevels {
  /** As the user set it; `level` is what is drawn. */
  brightness: number;
  lamp: number;
  /** An effect's colours, lamp i taking stop i mod n; `lamp` is then their mean. */
  palette?: readonly number[];
  sky: { top: number; mid: number };
}

const WARM = LAMP_COLOURS[0];
const SKY_WARM = { top: 0x6e5a4c, mid: 0x2a211e };
const SKY_CINEMA = { top: 0x2a2052, mid: 0x130e2b };
const CINEMA_LAMP = 0xa99bff;
const CINEMA_SHARE = 0.2;
const CINEMA_AMBIENT = 0.25;
const EFFECT_AMBIENT = 0.55;
const SKY_NIGHT = { top: 0x121d3d, mid: 0x0a1024 };
const SKY_DUSK = { top: 0x3a3550, mid: 0x171525 };
const SKY_DAY = { top: 0x8fa3c4, mid: 0x3a4658 };
/** The stored default lands on dusk; the scene's light rig bends at the same point. */
export const DUSK_AT = ROOM_AMBIENT_DEFAULT / 100;
/** At 1% a Hue light still glows: the room must not read as off. */
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

function meanOf(colours: readonly number[]): number {
  const sum = colours.reduce<[number, number, number]>((acc, c) => {
    const [r, g, b] = channels(c);
    return [acc[0] + r, acc[1] + g, acc[2] + b];
  }, [0, 0, 0]);
  return rgb(sum[0] / colours.length, sum[1] / colours.length, sum[2] / colours.length);
}

function skyOf(colour: number): RoomMood["sky"] {
  return { top: mix(colour, 0x0b0b12, 0.8), mid: mix(colour, 0x07070c, 0.93) };
}

function mixSky(a: RoomMood["sky"], b: RoomMood["sky"], t: number): RoomMood["sky"] {
  return { top: mix(a.top, b.top, t), mid: mix(a.mid, b.mid, t) };
}

/** How far past dusk toward day, 0 at or below the default. */
export function pastDusk(daylight: number): number {
  return Math.max(0, (daylight - DUSK_AT) / (1 - DUSK_AT));
}

function unlitSky(daylight: number): RoomMood["sky"] {
  return daylight <= DUSK_AT ? mixSky(SKY_NIGHT, SKY_DUSK, daylight / DUSK_AT) : mixSky(SKY_DUSK, SKY_DAY, pastDusk(daylight));
}

const level = (brightness: number | undefined) => LEVEL_FLOOR + (1 - LEVEL_FLOOR) * Math.min(Math.max(brightness ?? 1, 0), 1);

export function roomMood(mode: LightingModeConfig | null, daylight = DUSK_AT): RoomMood {
  // The control state keeps every mode's last payload through a switch: read the running kind's.
  const payload =
    mode?.kind === LIGHTING_MODE_KIND.SOLID ? mode.solid : mode?.kind === LIGHTING_MODE_KIND.EFFECT ? mode.effect : mode?.ambilight;
  const mood = moodOf(mode);
  const sky =
    mode?.kind === LIGHTING_MODE_KIND.OFF ? unlitSky(daylight) : mixSky(mood.sky, SKY_DAY, pastDusk(daylight) * (1 - mood.ambient));
  return { ...mood, sky, daylight, brightness: mode?.kind === LIGHTING_MODE_KIND.OFF ? 0 : (payload?.brightness ?? 1) };
}

function moodOf(mode: LightingModeConfig | null): Omit<RoomMood, "brightness" | "daylight"> {
  if (!mode) return { level: 1, ambient: 1, strip: 1, lamp: WARM, sky: SKY_WARM };
  switch (mode.kind) {
    case LIGHTING_MODE_KIND.OFF:
      return { level: 0, ambient: 0, strip: 0, lamp: WARM, sky: SKY_NIGHT };
    case LIGHTING_MODE_KIND.SOLID: {
      const solid = mode.solid;
      if (!solid) return { level: 1, ambient: 1, strip: 1, lamp: WARM, sky: SKY_WARM };
      const c = solid.kelvin != null ? kelvinToRgb(solid.kelvin) : solid;
      const lamp = rgb(c.r, c.g, c.b);
      const lit = level(solid.brightness);
      return { level: lit, ambient: lit, strip: lit, lamp, sky: skyOf(lamp) };
    }
    case LIGHTING_MODE_KIND.EFFECT: {
      // No payload reads as the default effect, as the contract's normaliser reads one.
      const effect = mode.effect ?? DEFAULT_EFFECT;
      const palette = paletteStops(paletteOf(effect), effect).map((stop) => Number.parseInt(stop.slice(1), 16));
      const lamp = palette.length > 0 ? meanOf(palette) : WARM;
      const lit = level(effect.brightness);
      return { level: lit, ambient: lit * EFFECT_AMBIENT, strip: lit, lamp, ...(palette.length > 1 ? { palette } : {}), sky: skyOf(lamp) };
    }
    default:
      const lit = level(mode.ambilight?.brightness);
      return { level: lit * CINEMA_SHARE, ambient: CINEMA_AMBIENT, strip: lit, lamp: CINEMA_LAMP, sky: SKY_CINEMA };
  }
}

export function paletteColour(palette: readonly number[] | undefined, i: number): number | undefined {
  return palette && palette.length > 0 ? palette[i % palette.length] : undefined;
}

export function hexCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}
