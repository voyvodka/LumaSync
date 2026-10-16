// A Hue light in the room, drawn as its fixture: a static body (pole, base, canopy, bar) merged with
// the furniture, and the lit part — the shade, the bar's back, the strip — as the lamp's instance in
// the one bulb mesh, so a live colour later recolours an instance instead of rebuilding the room.
import { Matrix4, Quaternion, Vector3 } from "three";

import { CEILING_MOUNT_M, type LampFamily, ONE_SIDED } from "../../model/lampFamily";
import type { ScenePoint } from "../../model/roomSpace";
import { PALETTE } from "./palette";
import { block, type Part, ring, rod, transformParts } from "./parts";

export type LampShape = "globe" | "drum" | "flare" | "bar";

/** The lit part; `radii` are half-extents. */
export interface LampGlow {
  at: ScenePoint;
  radii: [number, number, number];
  shape: LampShape;
  /** The lit part's turn; absent ⇒ upright and square to the room. */
  rotation?: Quaternion;
}

export interface LampFixture {
  body: Part[];
  glow: LampGlow;
  /** A one-sided fixture's throw, a unit vector, and its half-angle in radians; absent ⇒ all round. */
  beam?: { aim: Vector3; spread: number };
}



const CANOPY = 0xefe9df;
const BAR = 0x1d1e21;
const BULB_RADIUS = 0.055;
/** A bulb in a ceiling socket hangs this far below on its cord. */
const BULB_DROP = 0.32;
/** Half-angles of the light thrown straight down: a downlight's narrow cone, a pendant's wide one. */
const DOWNLIGHT_SPREAD = 0.42;
const PENDANT_SPREAD = 1.05;

/** The fixture for one light at `at`, standing on a surface at `surface` (the floor or the top of
 *  the piece under it), in a room `ceiling` high. The light's own point stays where the bridge or
 *  the map put it; the body is drawn around it. */
export function lampFixture(family: LampFamily, at: ScenePoint, surface: number, ceiling: number, facing = 0): LampFixture {
  if (ONE_SIDED.has(family)) return oneSided(family, at, surface, facing);
  const { x, z } = at;
  const y = Math.max(at.y, surface + 0.05);
  switch (family) {
    case "lightstrip":
      return { body: [], glow: { at: { x, y, z }, radii: [0.32, 0.012, 0.012], shape: "bar" } };
    case "tube":
      return { body: [], glow: { at: { x, y, z }, radii: [0.3, 0.02, 0.02], shape: "bar" } };
    case "floorLamp": {
      const shadeY = Math.max(y, 0.6);
      return {
        body: [
          rod(0.15, 0.16, 0.02, x, 0, z, PALETTE.metal, 24),
          rod(0.012, 0.012, Math.max(shadeY - 0.12, 0.05), x, 0.02, z, PALETTE.metal, 8),
        ],
        glow: { at: { x, y: shadeY, z }, radii: [0.16, 0.13, 0.16], shape: "drum" },
      };
    }
    case "tableLamp": {
      // A table lamp stands on what is under it: placed high, its stem ran up to the ceiling.
      const shadeY = Math.min(Math.max(y, surface + 0.28), surface + 0.55);
      return {
        body: [rod(0.055, 0.075, Math.max(shadeY - surface - 0.1, 0.05), x, surface, z, CANOPY, 16)],
        glow: { at: { x, y: shadeY, z }, radii: [0.12, 0.09, 0.12], shape: "drum" },
      };
    }
    case "pendant": {
      // Hung at least to head height: placed on the floor, its cord ran the room's height.
      const shadeY = Math.min(Math.max(y, 1.2), ceiling - 0.3);
      return {
        body: overhead([
          rod(0.004, 0.004, Math.max(ceiling - shadeY - 0.06, 0.02), x, shadeY + 0.06, z, BAR, 6),
          rod(0.06, 0.06, 0.02, x, ceiling - 0.02, z, CANOPY, 16),
        ]),
        glow: { at: { x, y: shadeY, z }, radii: [0.18, 0.09, 0.18], shape: "flare" },
        beam: { aim: DOWN.clone(), spread: PENDANT_SPREAD },
      };
    }
    case "ceiling":
      // The diffuser stands proud of its rim: under a plate, the camera from above saw a grey disc.
      return {
        body: overhead([ring(0.17, 0.2, 0.012, x, ceiling - 0.012, z, CANOPY)]),
        glow: { at: { x, y: ceiling - 0.01, z }, radii: [0.18, 0.012, 0.18], shape: "drum" },
      };
    case "go": {
      // A Go is a pebble on its cradle: wider than tall, lit all over.
      const domeY = surface + 0.06;
      return {
        body: [rod(0.085, 0.09, 0.012, x, surface, z, CANOPY, 24)],
        glow: { at: { x, y: domeY, z }, radii: [0.085, 0.05, 0.085], shape: "globe" },
      };
    }
    case "spot": {
      if (y >= ceiling - CEILING_MOUNT_M) {
        // Set in the ceiling: a trim ring round a lens that throws its light down. The lens stands
        // proud of the trim, since the camera only ever sees the ceiling from above.
        return {
          body: overhead([ring(0.045, 0.065, 0.01, x, ceiling - 0.01, z, CANOPY)]),
          glow: { at: { x, y: ceiling - 0.004, z }, radii: [0.05, 0.008, 0.05], shape: "drum" },
          beam: { aim: DOWN.clone(), spread: DOWNLIGHT_SPREAD },
        };
      }
      const headY = Math.max(y, surface + 0.12);
      return {
        body: [rod(0.04, 0.045, 0.02, x, surface, z, BAR, 12), rod(0.01, 0.01, Math.max(headY - surface - 0.06, 0.02), x, surface + 0.02, z, BAR, 6)],
        glow: { at: { x, y: headY, z }, radii: [0.045, 0.045, 0.045], shape: "globe" },
      };
    }
    case "wall":
      return { body: [], glow: { at: { x, y, z }, radii: [0.1, 0.14, 0.06], shape: "drum" } };
    default: {
      if (y < ceiling - CEILING_MOUNT_M) {
        return { body: [], glow: { at: { x, y, z }, radii: [BULB_RADIUS, BULB_RADIUS, BULB_RADIUS], shape: "globe" } };
      }
      // A bulb in a ceiling socket hangs from a short cord, as a bare smart bulb does.
      const bulbY = ceiling - BULB_DROP;
      const socket = bulbY + BULB_RADIUS * 0.7;
      return {
        body: overhead([
          rod(0.022, 0.018, 0.05, x, socket, z, BAR, 12),
          rod(0.004, 0.004, ceiling - socket - 0.065, x, socket + 0.05, z, BAR, 6),
          rod(0.045, 0.045, 0.015, x, ceiling - 0.015, z, CANOPY, 20),
        ]),
        glow: { at: { x, y: bulbY, z }, radii: [BULB_RADIUS, BULB_RADIUS * 1.15, BULB_RADIUS], shape: "globe" },
      };
    }
  }
}

/** Turned to face the throw: the lit side of the fixture's local frame looks down -z. */
function oneSided(family: LampFamily, at: ScenePoint, surface: number, facing: number): LampFixture {
  const place = new Matrix4().makeTranslation(at.x, 0, at.z).multiply(new Matrix4().makeRotationY(-facing));
  const turn = new Quaternion().setFromAxisAngle(UP, -facing);
  const local = (x: number, y: number, z: number): ScenePoint => {
    const p = new Vector3(x, y, z).applyMatrix4(place);
    return { x: p.x, y: p.y, z: p.z };
  };
  const throwAt = (tilt: number) => new Vector3(0, Math.sin(tilt), -Math.cos(tilt)).applyQuaternion(turn);
  const tilted = (tilt: number) => turn.clone().multiply(new Quaternion().setFromAxisAngle(SIDE, tilt - Math.PI / 2));
  const body: Part[] = [];
  let glow: LampGlow;
  let beam: LampFixture["beam"];
  switch (family) {
    case "playBar": {
      // A Play bar stands about 25 cm tall on its foot and lights the wall behind it, its front dark;
      // one placed higher hangs on the wall.
      const half = 0.125;
      const y = Math.max(at.y, surface + 0.05);
      const bottom = Math.max(surface, y - half);
      body.push(block(0.04, half * 2, 0.036, 0, bottom, 0, BAR, 0.008));
      if (bottom - surface < 0.03) body.push(block(0.07, 0.012, 0.06, 0, surface, 0, BAR, 0.004));
      glow = { at: local(0, bottom + half, -0.021), radii: [0.017, half * 0.92, 0.004], shape: "bar", rotation: turn };
      beam = { aim: throwAt(0.12), spread: 1.05 };
      break;
    }
    case "signe": {
      // Signe's light is its back: a lit spine up a dark pole, washing the wall it leans to.
      const height = 1.45;
      body.push(rod(0.12, 0.13, 0.015, 0, surface, 0, PALETTE.metal, 20), block(0.03, height, 0.03, 0, surface + 0.015, 0, BAR, 0.006));
      glow = { at: local(0, surface + 0.015 + height / 2, -0.017), radii: [0.012, height * 0.47, 0.004], shape: "bar", rotation: turn };
      beam = { aim: throwAt(0.35), spread: 1.1 };
      break;
    }
    case "iris": {
      // Iris: a round glass shade held tilted back in a ring on a low base, its light thrown up and out.
      const tilt = 0.6;
      const centreY = surface + 0.11;
      body.push(rod(0.055, 0.06, 0.018, 0, surface, 0, CANOPY, 20), block(0.018, centreY - surface, 0.018, 0, surface, 0.035, CANOPY, 0.006));
      glow = { at: local(0, centreY, 0), radii: [0.085, 0.03, 0.085], shape: "drum", rotation: tilted(tilt) };
      beam = { aim: throwAt(tilt), spread: 0.8 };
      break;
    }
    default: {
      // Bloom: a small bowl tipped on its foot, a wash thrown up the wall in front of it.
      const tilt = 0.75;
      const centreY = surface + 0.08;
      body.push(rod(0.05, 0.055, 0.02, 0, surface, 0, CANOPY, 20));
      glow = { at: local(0, centreY, 0), radii: [0.065, 0.05, 0.065], shape: "flare", rotation: tilted(tilt) };
      beam = { aim: throwAt(tilt), spread: 0.75 };
      break;
    }
  }
  transformParts(body, place);
  return { body, glow, beam };
}

function overhead(parts: Part[]): Part[] {
  for (const part of parts) part.castShadow = false;
  return parts;
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const SIDE = new Vector3(1, 0, 0);
