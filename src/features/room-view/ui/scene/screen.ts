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
  /** Footprints (centre and half sizes in the scene) that shade the floor. */
  footprints: Array<{ x: number; z: number; hw: number; hd: number; shade: number }>;
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
  const depth = monitor ? 0.022 : 0.035;

  const parts: Part[] = [block(width, height, depth, centre.x, bottom, centre.z, PALETTE.bezel, monitor ? 0.006 : 0.01)];
  const footprints: ScreenBuild["footprints"] = [];

  const onDesk = monitor && deskUnder;
  const covered = config.furniture.some((f) => {
    const sx = tv.x + tv.width / 2;
    const sy = tv.y + tv.height / 2;
    return sx >= f.x && sx <= f.x + f.width && sy >= f.y - 0.3 && sy <= f.y + f.height;
  });

  if (onDesk) {
    const neck = Math.max(bottom - deskTop, 0) + 0.08;
    parts.push(block(Math.min(0.26, width * 0.4), 0.012, 0.18, centre.x, deskTop, centre.z - 0.02, PALETTE.metal, 0.006));
    parts.push(block(0.05, neck, 0.03, centre.x, deskTop, centre.z - depth / 2 - 0.015, PALETTE.metal, 0.008));
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
    parts.push(block(Math.min(width * 0.7, 1.1), 0.065, 0.09, centre.x, TV_UNIT_HEIGHT, unitZ + TV_UNIT_DEPTH / 2 - 0.08, PALETTE.metal, 0.02));
    footprints.push({ x: centre.x, z: unitZ, hw: unitW / 2, hd: TV_UNIT_DEPTH / 2, shade: 0.4 });
  } else if (!monitor && bottom < TV_UNIT_HEIGHT + 0.04 && !covered) {
    // A screen too low for a unit stands on its own feet; one over a piece of furniture stands on it.
    const footH = Math.max(bottom, 0.02);
    for (const sx of [-1, 1]) {
      parts.push(block(0.06, footH + 0.04, 0.22, centre.x + sx * width * 0.36, 0, centre.z + 0.05, PALETTE.metal, 0.01));
    }
  }

  const panel = new PlaneGeometry(Math.max(width - 0.02, 0.01), Math.max(height - 0.02, 0.01), 12, 6);
  // A faint top-to-bottom fall-off, the way a dark screen catches the room's light, and one soft
  // diagonal sheen across the glass, so it reads as a screen rather than a painted board.
  const top = new Color(0x26324d);
  const low = new Color(PALETTE.panel);
  const sheen = new Color(0x3a4866);
  const uv = panel.getAttribute("uv");
  const colours = new Float32Array(uv.count * 3);
  const c = new Color();
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    c.copy(low).lerp(top, v);
    const band = Math.exp(-(((u * 0.8 + v * 0.6 - 0.62) / 0.11) ** 2));
    c.lerp(sheen, band * 0.55);
    colours.set([c.r, c.g, c.b], i * 3);
  }
  panel.setAttribute("color", new BufferAttribute(colours, 3));
  // Clear of the bezel's face: a millimetre z-fought across the subdivided glass as speckle.
  panel.translate(centre.x, mount, centre.z + depth / 2 + 0.004);

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

  return { layout: { centre, width, height, backlight }, parts, panel, footprints };
}
