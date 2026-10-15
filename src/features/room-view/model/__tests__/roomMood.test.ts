import { describe, expect, it } from "vitest";

import { EFFECT_IDS, PALETTE_IDS } from "@/shared/contracts/effects";
import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";

import { LAMP_COLOURS } from "../lampColours";
import { paletteColour, roomMood } from "../roomMood";

const channels = (hex: number) => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];

describe("roomMood", () => {
  it("leaves the room's lamps dark under a night sky when the lights are off", () => {
    const mood = roomMood({ kind: LIGHTING_MODE_KIND.OFF });
    expect(mood.level).toBe(0);
    const [r, , b] = channels(mood.sky.top);
    expect(b).toBeGreaterThan(r!);
  });

  it("lights every lamp in a Solid colour, at its brightness, under a sky of that colour", () => {
    const mood = roomMood({ kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 255, g: 0, b: 0, brightness: 0.5 } });
    expect(mood.lamp).toBe(0xff0000);
    expect(mood.level).toBeGreaterThan(0.5);
    expect(mood.level).toBeLessThan(1);
    const [r, g, b] = channels(mood.sky.top);
    expect(r).toBeGreaterThan(g!);
    expect(r).toBeGreaterThan(b!);
  });

  // A Hue light at 1% still glows; the room reading as off at the bottom of the slider was wrong.
  it("keeps a lamp at the lowest brightness visibly lit", () => {
    expect(roomMood({ kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 255, g: 255, b: 255, brightness: 0 } }).level).toBeGreaterThan(0);
  });

  it("reads a White tab's temperature, not the stale RGB beside it", () => {
    const mood = roomMood({ kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 0, g: 0, b: 255, brightness: 1, kelvin: 2700 } });
    const [r, , b] = channels(mood.lamp);
    expect(r).toBeGreaterThan(b!);
  });

  it("holds an effect's lamps in its palette, not the warm placeholder", () => {
    const mood = roomMood({
      kind: LIGHTING_MODE_KIND.EFFECT,
      effect: { id: EFFECT_IDS.BREATHE, speed: 0.5, brightness: 1, palette: PALETTE_IDS.CUSTOM, colors: [{ r: 0, g: 255, b: 0 }] },
    });
    expect(mood.lamp).toBe(0x00ff00);
  });

  it("dims the lamps to a cool cinema light in Ambilight, and keeps them warm with no mode known", () => {
    const ambilight = roomMood({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
    const [r, , b] = channels(ambilight.lamp);
    expect(b).toBeGreaterThan(r!);
    expect(ambilight.level).toBeLessThan(0.7);
    expect(ambilight.sky).not.toEqual(roomMood(null).sky);
    expect(roomMood(null)).toMatchObject({ level: 1, lamp: LAMP_COLOURS[0] });
  });

  // The whole room turned the mode's colour; the reference keeps a dark room with local light in it.
  it("keeps the room itself dim under Ambilight and dimmer than its lamps under an effect", () => {
    const ambilight = roomMood({ kind: LIGHTING_MODE_KIND.AMBILIGHT });
    expect(ambilight.ambient).toBeLessThan(0.5);
    expect(ambilight.strip).toBeGreaterThan(ambilight.level);
    const effect = roomMood({
      kind: LIGHTING_MODE_KIND.EFFECT,
      effect: { id: EFFECT_IDS.BREATHE, speed: 0.5, brightness: 1, palette: PALETTE_IDS.CUSTOM, colors: [{ r: 0, g: 255, b: 0 }] },
    });
    expect(effect.ambient).toBeLessThan(effect.level);
    expect(roomMood({ kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 255, g: 255, b: 255, brightness: 1 } }).ambient).toBe(1);
  });

  // Effect read the same as Solid white: one middle colour for every lamp, and warm with no payload.
  it("spreads an effect's colours over the lamps, its mean the room's, the default effect's with none chosen", () => {
    const mood = roomMood({
      kind: LIGHTING_MODE_KIND.EFFECT,
      effect: {
        id: EFFECT_IDS.BREATHE,
        speed: 0.5,
        brightness: 1,
        palette: PALETTE_IDS.CUSTOM,
        colors: [
          { r: 255, g: 0, b: 0 },
          { r: 0, g: 0, b: 255 },
        ],
      },
    });
    expect(mood.palette).toEqual([0xff0000, 0x0000ff]);
    expect(mood.lamp).toBe(0x800080);
    expect([0, 1, 2].map((i) => paletteColour(mood.palette, i))).toEqual([0xff0000, 0x0000ff, 0xff0000]);

    const unchosen = roomMood({ kind: LIGHTING_MODE_KIND.EFFECT });
    expect(unchosen.palette?.length).toBeGreaterThan(1);
    expect(unchosen.lamp).not.toBe(LAMP_COLOURS[0]);
    expect(roomMood({ kind: LIGHTING_MODE_KIND.SOLID, solid: { r: 255, g: 0, b: 0, brightness: 1 } }).palette).toBeUndefined();
  });
});
