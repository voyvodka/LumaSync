import type { TranslationKey } from "@/features/i18n/catalogue";

/** The plain names a colour scene is suggested under, in hue order. */
export const COLOUR_NAMES = [
  "white",
  "grey",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "magenta",
  "pink",
] as const;
export type ColourName = (typeof COLOUR_NAMES)[number];

/** Where each hue name starts, in degrees; red wraps past 345°. */
const HUES: readonly [number, ColourName][] = [
  [0, "red"],
  [15, "orange"],
  [38, "amber"],
  [50, "yellow"],
  [68, "lime"],
  [90, "green"],
  [150, "teal"],
  [175, "cyan"],
  [200, "blue"],
  [235, "indigo"],
  [260, "purple"],
  [290, "magenta"],
  [320, "pink"],
  [345, "red"],
];

/**
 * The word a person would use for a colour: a new scene offered "#FF0010" as its name. Pale or
 * washed-out colours are white or grey; the rest are named by their hue.
 */
export function colourName(r: number, g: number, b: number): ColourName {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const chroma = max - min;
  const saturation = max === 0 ? 0 : chroma / max;
  if (saturation < 0.18) return max > 0.75 ? "white" : "grey";
  let hue: number;
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  if (max === rr) hue = ((gg - bb) / chroma) % 6;
  else if (max === gg) hue = (bb - rr) / chroma + 2;
  else hue = (rr - gg) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  let name: ColourName = "red";
  for (const [start, n] of HUES) if (hue >= start) name = n;
  // A deep cyan is what people call teal.
  return name === "cyan" && max < 0.65 ? "teal" : name;
}

/** Each name's words, written out so the catalogue check sees every key. */
export const COLOUR_NAME_KEYS = {
  white: "lights:scenes.colourNames.white",
  grey: "lights:scenes.colourNames.grey",
  red: "lights:scenes.colourNames.red",
  orange: "lights:scenes.colourNames.orange",
  amber: "lights:scenes.colourNames.amber",
  yellow: "lights:scenes.colourNames.yellow",
  lime: "lights:scenes.colourNames.lime",
  green: "lights:scenes.colourNames.green",
  teal: "lights:scenes.colourNames.teal",
  cyan: "lights:scenes.colourNames.cyan",
  blue: "lights:scenes.colourNames.blue",
  indigo: "lights:scenes.colourNames.indigo",
  purple: "lights:scenes.colourNames.purple",
  magenta: "lights:scenes.colourNames.magenta",
  pink: "lights:scenes.colourNames.pink",
} as const satisfies Record<ColourName, TranslationKey>;
