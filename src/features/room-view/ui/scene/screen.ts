// The captured screen and what it stands on: a monitor on its stand when a desk is under it, a TV
// over a low unit with a soundbar when it hangs on the wall.
import { BufferAttribute, Color, PlaneGeometry } from "three";

import {
  type RoomMapConfig,
  resolveFurnitureTop,
  resolveScreenKind,
  SCREEN_KINDS,
  stripCentre,
  stripPoints,
} from "@/shared/contracts/roomMap";

import { DESK_TOP, type FurnitureModel } from "../../model/furnitureModel";
import { roomToScene, type ScenePoint, tvMountHeight } from "../../model/roomSpace";
import { paletteColour } from "../../model/roomMood";
import { PALETTE } from "./palette";
import { block, type Part } from "./parts";

/** A screen this close to the TV wall hangs on it; further out it stands in the room. */
const WALL_REACH = 0.4;
/** A strip this close to the screen is its backlight. */
const BACKLIGHT_REACH = 1.0;
const TV_UNIT_HEIGHT = 0.46;
const TV_UNIT_DEPTH = 0.42;
/** A monitor's stand: the panel's foot this far over the desk, the panel this far in from its back. */
const MONITOR_STAND = 0.1;
const MONITOR_SETBACK = 0.14;
/** How far a running mode's picture shows over the dark glass: a full one outshone the room's lights. */
const SCREEN_PICTURE = 0.8;

export interface ScreenLayout {
  centre: ScenePoint;
  width: number;
  height: number;
  /** The wall glow's plane, when a strip lights the screen from behind. */
  backlight: { x: number; y: number; z: number; width: number; height: number; screenWidth: number; screenHeight: number } | null;
}

export interface ScreenBuild {
  layout: ScreenLayout;
  parts: Part[];
  /** The panel's face, drawn unlit so it reads as a screen, not a slab. */
  panel: PlaneGeometry;
  /** Shows a picture in the lamps' colours while they run, the dark glass while they do not. */
  paint(lampColour: number | null, level: number, palette?: readonly number[]): void;
  /** Footprints (centre and half sizes in the scene) that shade the floor. */
  footprints: Array<{ x: number; z: number; hw: number; hd: number; shade: number }>;
  /** The desk a monitor stands on, which carries it when it is carried. */
  deskId: string | null;
}

export function buildScreen(config: RoomMapConfig, models: ReadonlyMap<string, FurnitureModel>): ScreenBuild | null {
  const tv = config.tvAnchor;
  if (!tv) return null;
  const dims = config.dimensions;
  const width = tv.width;
  const height = width * 0.5625;
  const desk = config.furniture.find((f) => {
    const model = models.get(f.id);
    return model?.kind === "desk" && model.screenX !== null;
  });
  const deskUnder = desk !== undefined;
  // The user's pick wins; absent, a desk under the screen makes it a monitor.
  const kind = resolveScreenKind(tv.screenKind) ?? (deskUnder ? SCREEN_KINDS.MONITOR : SCREEN_KINDS.TV);
  const monitor = kind === SCREEN_KINDS.MONITOR;
  const deskTop = desk ? (resolveFurnitureTop(desk) ?? DESK_TOP) : DESK_TOP;
  let mount = tvMountHeight(tv, dims);
  let planY = tv.y + tv.height / 2;
  if (monitor && desk) {
    // The room's 40% default sank a wide monitor into the desk and floated a small one on a pole:
    // with no height of its own it stands on the desk, and a set height never goes through the top.
    const resting = deskTop + MONITOR_STAND + height / 2;
    mount = tv.mountHeightMeters == null ? resting : Math.max(mount, deskTop + 0.02 + height / 2);
    // On the top, near its back, where a desk's monitor stands; a turned desk keeps the plan's spot.
    if ((desk.rotation ?? 0) % 180 === 0 && desk.height > MONITOR_SETBACK * 2) {
      planY = Math.min(Math.max(planY, desk.y + MONITOR_SETBACK), desk.y + desk.height - MONITOR_SETBACK);
    }
  }
  const centre = roomToScene(tv.x + tv.width / 2, planY, mount, dims);
  const bottom = mount - height / 2;
  const wallZ = -dims.depthMeters / 2;
  const onWall = centre.z - wallZ <= WALL_REACH;
  // A thin panel with a smaller housing behind it, as a flat screen is built; one slab read as a box.
  const depth = 0.014;
  const housing = { w: width * (monitor ? 0.5 : 0.62), h: height * (monitor ? 0.5 : 0.52), d: monitor ? 0.03 : 0.04 };
  const parts: Part[] = [
    block(width, height, depth, centre.x, bottom, centre.z, PALETTE.bezel, 0.005),
    block(housing.w, housing.h, housing.d, centre.x, mount - housing.h * 0.6, centre.z - depth / 2 - housing.d / 2 + 0.002, PALETTE.bezel, 0.012),
    // The standby light under the glass: red on a TV, white on a monitor.
    block(0.008, 0.004, 0.004, centre.x, bottom + 0.002, centre.z + depth / 2, monitor ? 0xd8dde6 : 0xb3362c, 0),
  ];
  const footprints: ScreenBuild["footprints"] = [];

  const onDesk = monitor && deskUnder;
  const covered = config.furniture.some((f) => {
    const sx = tv.x + tv.width / 2;
    const sy = tv.y + tv.height / 2;
    return sx >= f.x && sx <= f.x + f.width && sy >= f.y - 0.3 && sy <= f.y + f.height;
  });

  if (onDesk) {
    const neck = Math.max(bottom - deskTop, 0) + 0.08;
    const back = centre.z - depth / 2 - housing.d;
    parts.push(block(Math.min(0.26, width * 0.4), 0.012, 0.18, centre.x, deskTop, back + 0.02, PALETTE.metal, 0.006));
    parts.push(block(0.05, neck, 0.03, centre.x, deskTop, back - 0.012, PALETTE.metal, 0.008));
    // Where the neck meets the housing: the joint a monitor turns on.
    parts.push(block(0.08, 0.08, 0.02, centre.x, mount - 0.07, back - 0.004, PALETTE.metalSoft, 0.008));
  } else if (!monitor && bottom >= TV_UNIT_HEIGHT + 0.04 && !covered) {
    const unitW = Math.min(Math.max(width * 1.15, 0.9), dims.widthMeters - 0.1);
    const unitZ = onWall ? wallZ + TV_UNIT_DEPTH / 2 + 0.02 : centre.z + TV_UNIT_DEPTH / 2 - 0.1;
    const legH = 0.06;
    parts.push(block(unitW, TV_UNIT_HEIGHT - legH - 0.025, TV_UNIT_DEPTH, centre.x, legH, unitZ, PALETTE.walnut, 0.015));
    parts.push(block(unitW + 0.01, 0.025, TV_UNIT_DEPTH + 0.01, centre.x, TV_UNIT_HEIGHT - 0.025, unitZ, PALETTE.oak, 0.008));
    const drawers = Math.max(2, Math.round(unitW / 0.5));
    const front = unitZ + TV_UNIT_DEPTH / 2 + 0.001;
    for (let i = 1; i < drawers; i++) {
      parts.push(block(0.006, TV_UNIT_HEIGHT - legH - 0.07, 0.004, centre.x - unitW / 2 + (unitW * i) / drawers, legH + 0.02, front, PALETTE.floorGap, 0));
    }
    for (const sx of [-1, 1]) {
      parts.push(block(0.03, legH, 0.03, centre.x + sx * (unitW / 2 - 0.06), 0, unitZ, PALETTE.metal, 0.006));
    }
    const bar = { w: Math.min(width * 0.7, 1.1), z: unitZ + TV_UNIT_DEPTH / 2 - 0.08 };
    parts.push(block(bar.w, 0.065, 0.09, centre.x, TV_UNIT_HEIGHT, bar.z, PALETTE.metal, 0.02));
    parts.push(block(bar.w - 0.04, 0.045, 0.004, centre.x, TV_UNIT_HEIGHT + 0.01, bar.z + 0.045, PALETTE.keyboard, 0));
    if (!onWall && bottom - TV_UNIT_HEIGHT < 0.45) {
      // Out in the room the TV stands on the unit on a pedestal, behind the soundbar.
      const z = centre.z - depth / 2 - housing.d / 2;
      parts.push(block(Math.min(0.5, width * 0.35), 0.012, 0.22, centre.x, TV_UNIT_HEIGHT, z, PALETTE.metal, 0.006));
      parts.push(block(0.07, bottom - TV_UNIT_HEIGHT + 0.06, 0.025, centre.x, TV_UNIT_HEIGHT, z, PALETTE.metal, 0.008));
    }
    footprints.push({ x: centre.x, z: unitZ, hw: unitW / 2, hd: TV_UNIT_DEPTH / 2, shade: 0.4 });
  } else if (!monitor && bottom < TV_UNIT_HEIGHT + 0.04 && !covered) {
    // A screen too low for a unit stands on its own feet; one over a piece of furniture stands on it.
    const footH = Math.max(bottom, 0.02);
    for (const sx of [-1, 1]) {
      parts.push(block(0.06, footH + 0.04, 0.22, centre.x + sx * width * 0.36, 0, centre.z + 0.05, PALETTE.metal, 0.01));
    }
  }

  const panel = new PlaneGeometry(Math.max(width - 0.016, 0.01), Math.max(height - 0.016, 0.01), 12, 6);
  // A faint top-to-bottom fall-off, the way a dark screen catches the room's light, and one soft
  // diagonal sheen across the glass, so it reads as a screen rather than a painted board.
  const top = new Color(0x26324d);
  const low = new Color(PALETTE.panel);
  const sheen = new Color(0x3a4866);
  const uv = panel.getAttribute("uv");
  const glass = new Float32Array(uv.count * 3);
  const c = new Color();
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    c.copy(low).lerp(top, v);
    const band = Math.exp(-(((u * 0.8 + v * 0.6 - 0.62) / 0.11) ** 2));
    c.lerp(sheen, band * 0.55);
    glass.set([c.r, c.g, c.b], i * 3);
  }
  const colours = new BufferAttribute(glass.slice(), 3);
  panel.setAttribute("color", colours);
  // Clear of the bezel's face: a millimetre z-fought across the subdivided glass as speckle.
  panel.translate(centre.x, mount, centre.z + depth / 2 + 0.004);

  const left = new Color();
  const right = new Color();
  const picture = new Color();
  const white = new Color(0xfff4e6);
  const paint = (lampColour: number | null, level: number, palette?: readonly number[]) => {
    const on = lampColour === null ? 0 : Math.min(Math.max(level, 0), 1) * SCREEN_PICTURE;
    const array = colours.array as Float32Array;
    if (on === 0) {
      array.set(glass);
      colours.needsUpdate = true;
      return;
    }
    // The picture the lights are taken from: the palette's first stops across it, else the lamps' colour.
    left.set(paletteColour(palette, 0) ?? lampColour ?? 0);
    right.set(paletteColour(palette, 1) ?? lampColour ?? 0);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      // A frame of film rather than a tint: a lit sky over a darker ground, a soft bright spot and a
      // vignette — a flat wash read as the glass glowing, not as a picture.
      const sky = 1 / (1 + Math.exp(-(v - 0.4) * 18));
      const spot = Math.exp(-(((u - 0.64) / 0.16) ** 2 + ((v - 0.62) / 0.2) ** 2));
      const shade = (0.3 + 0.62 * sky) * (1 - 0.4 * ((u - 0.5) * 2) ** 2);
      picture.copy(left).lerp(right, u).multiplyScalar(shade).lerp(white, spot * 0.45);
      c.setRGB(glass[i * 3]!, glass[i * 3 + 1]!, glass[i * 3 + 2]!).lerp(picture, on);
      array[i * 3] = c.r;
      array[i * 3 + 1] = c.g;
      array[i * 3 + 2] = c.b;
    }
    colours.needsUpdate = true;
  };

  const sx = tv.x + tv.width / 2;
  const sy = tv.y + tv.height / 2;
  const lit = config.usbStrips.some((s) => {
    const { x: mx, y: my } = stripCentre(s);
    const xs = stripPoints(s).map((p) => p.x);
    const overlaps = Math.max(...xs) >= tv.x && Math.min(...xs) <= tv.x + tv.width;
    return Math.hypot(mx - sx, my - sy) <= BACKLIGHT_REACH || (overlaps && Math.abs(my - sy) <= BACKLIGHT_REACH);
  });
  const backlight = lit
    ? {
        x: centre.x,
        y: mount,
        z: onWall ? wallZ + 0.012 : centre.z - depth,
        width: width * 1.45,
        height: height * 1.6,
        screenWidth: width,
        screenHeight: height,
      }
    : null;

  return { layout: { centre, width, height, backlight }, parts, panel, paint, footprints, deskId: onDesk && desk ? desk.id : null };
}
