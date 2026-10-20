// While the room is edited, a one-sided light's throw is drawn as a soft fan from its lit part, so
// which way it shines reads without lighting the room. An all-round bulb already reads by its glow.
import { AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";

import { paletteColour } from "../../model/roomMood";
import { OVERLAY } from "./bloom";
import { extent, type Lamp } from "./glow";

/** It reaches the wall, ceiling or floor its aim meets, within these: one stopping short hung in mid-air. */
const REACH_M = { min: 0.3, max: 2.4 };
const MOUTH_MAX_M = 0.9;
/** Its spread drawn narrower: at a fixture's real half-angle a pendant's cone filled the room. */
const SPREAD_SHARE = 0.6;
const OPACITY = 0.32;
// Faded by how square it faces the eye: flat across, both sides added gave the silhouette a hard step.
const SOFT_SIDES = "diffuseColor.a *= pow(abs(dot(normalize(lmNormal), isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(lmView))), 1.5);";
/** Off, a cone still says where its light points, as the dark bulb still says where it is. */
const OFF_SHARE = 0.55;
const DOWN = new Vector3(0, -1, 0);
const RINGS = 8;
const SIDES = 24;

export interface Beams {
  group: Group;
  paint(lampColour: number | null, level: number, palette?: readonly number[]): void;
}

function toRoomEdge(at: Vector3, aim: Vector3, room: { w: number; d: number; h: number }): number {
  const exit = (p: number, v: number, lo: number, hi: number) => (v > 1e-6 ? (hi - p) / v : v < -1e-6 ? (lo - p) / v : Infinity);
  return Math.min(exit(at.x, aim.x, -room.w / 2, room.w / 2), exit(at.y, aim.y, 0, room.h), exit(at.z, aim.z, -room.d / 2, room.d / 2));
}

/** Opens along -y from the lit face, `a` by `b` across, not a point: a cone tip read as lit from the middle. */
function fan(a: number, b: number, mouth: number, reach: number): BufferGeometry {
  const position: number[] = [];
  const alpha: number[] = [];
  for (let k = 0; k <= RINGS; k++) {
    const t = k / RINGS;
    for (let s = 0; s <= SIDES; s++) {
      const angle = (s / SIDES) * Math.PI * 2;
      position.push(Math.cos(angle) * (a + t * mouth), -t * reach, Math.sin(angle) * (b + t * mouth));
      // Eight rings, so the fall-off along it is a curve and not four steps.
      alpha.push(1, 1, 1, (1 - t) ** 2);
    }
  }
  const index: number[] = [];
  for (let k = 0; k < RINGS; k++) {
    for (let s = 0; s < SIDES; s++) {
      const i = k * (SIDES + 1) + s;
      const j = i + SIDES + 1;
      index.push(i, j, i + 1, i + 1, j, j + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(alpha, 4));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function softSides(material: MeshBasicMaterial): MeshBasicMaterial {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 lmNormal;\nvarying vec3 lmView;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nlmNormal = normalMatrix * normal;\nlmView = -mvPosition.xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 lmNormal;\nvarying vec3 lmView;")
      .replace("#include <color_fragment>", `#include <color_fragment>\n${SOFT_SIDES}`);
  };
  material.customProgramCacheKey = () => "lm-beam";
  return material;
}

export function buildBeams(lamps: readonly Lamp[], room: { w: number; d: number; h: number }): Beams | null {
  const group = new Group();
  group.userData[OVERLAY] = true;
  const cones: { mesh: Mesh<BufferGeometry, MeshBasicMaterial>; lamp: Lamp; index: number }[] = [];
  lamps.forEach((lamp, index) => {
    if (lamp.outside || lamp.own) return;
    for (const light of [lamp.beam, lamp.back]) {
      if (!light) continue;
      const direction = light.aim.clone().normalize();
      const reach = Math.min(Math.max(toRoomEdge(new Vector3(lamp.at.x, lamp.at.y, lamp.at.z), direction, room), REACH_M.min), REACH_M.max);
      const mouth = Math.min(reach * Math.tan(Math.min(light.spread * SPREAD_SHARE, 1.2)), MOUTH_MAX_M);
      const turn = new Quaternion().setFromUnitVectors(DOWN, direction);
      const a = extent(lamp, new Vector3(1, 0, 0).applyQuaternion(turn));
      const b = extent(lamp, new Vector3(0, 0, 1).applyQuaternion(turn));
      const mesh = new Mesh(
        fan(a, b, mouth, reach),
        softSides(new MeshBasicMaterial({ transparent: true, vertexColors: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false })),
      );
      mesh.position.set(lamp.at.x, lamp.at.y, lamp.at.z);
      mesh.quaternion.copy(turn);
      group.add(mesh);
      cones.push({ mesh, lamp, index });
    }
  });
  if (cones.length === 0) return null;
  const colour = new Color();
  return {
    group,
    paint(lampColour, level, palette) {
      for (const { mesh, lamp, index } of cones) {
        mesh.material.color.copy(colour.set(paletteColour(palette, index) ?? lampColour ?? lamp.color));
        mesh.material.opacity = OPACITY * (OFF_SHARE + (1 - OFF_SHARE) * level);
      }
    },
  };
}
