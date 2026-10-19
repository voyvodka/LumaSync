// What a carried piece or light has caught on, drawn across the room at the level it is carried.
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineDashedMaterial, Mesh, MeshBasicMaterial, PlaneGeometry, type Quaternion } from "three";

import type { SnapGuide } from "@/features/room-map/model/snapGeometry";
import type { RoomDimensions } from "@/shared/contracts/roomMap";

import { OVERLAY } from "./bloom";
import { pillTexture } from "./pill";
import { SELECTION_COLOUR } from "./selection";

const TAG_PX = 18;
const TAG_GAP_PX = 8;
/** One per axis, and the mirror's line with the level it sets. */
const LINES = 4;

export interface SnapGuides3D {
  group: Group;
  /** Draws `guides` (plan metres) at height `level`, with `tag` over the point it names; empty hides them. */
  show(guides: readonly SnapGuide[], level: number, tag?: { text: string; x: number; z: number } | null): void;
  setPixelsPerMetre(ppm: number): void;
  orient(cameraQuaternion: Quaternion): void;
  dispose(): void;
}

export function buildSnapGuides(dims: RoomDimensions): SnapGuides3D {
  const group = new Group();
  group.name = "snap-guides";
  group.userData[OVERLAY] = true;
  group.visible = false;
  const w = dims.widthMeters;
  const d = dims.depthMeters;
  const lines: Line<BufferGeometry, LineDashedMaterial>[] = [];
  for (let i = 0; i < LINES; i++) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    const line = new Line(
      geometry,
      new LineDashedMaterial({ color: SELECTION_COLOUR, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    line.renderOrder = 12;
    line.visible = false;
    lines.push(line);
    group.add(line);
  }
  const pill = pillTexture(TAG_PX, null, 600);
  const tag = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: pill.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  tag.renderOrder = 13;
  tag.visible = false;
  group.add(tag);
  let tagText = "";
  let metresPerPx = 0.01;
  const sizeTag = () => {
    const h = TAG_PX * metresPerPx;
    tag.scale.set(h * pill.aspect, h, 1);
    tag.userData.lift = (TAG_GAP_PX * metresPerPx) + h / 2;
  };

  return {
    group,
    show(guides, level, named) {
      lines.forEach((line, i) => {
        const guide = guides[i];
        line.visible = guide !== undefined;
        if (!guide) return;
        const at = line.geometry.getAttribute("position") as Float32BufferAttribute;
        // Plan metres to the scene: x from the left wall, the plan's y toward the room from the screen wall.
        if (guide.axis === "x") {
          const x = guide.position - w / 2;
          at.setXYZ(0, x, level, -d / 2);
          at.setXYZ(1, x, level, d / 2);
        } else {
          const z = guide.position - d / 2;
          at.setXYZ(0, -w / 2, level, z);
          at.setXYZ(1, w / 2, level, z);
        }
        at.needsUpdate = true;
        line.geometry.computeBoundingSphere();
        line.computeLineDistances();
      });
      tag.visible = !!named;
      if (named) {
        if (named.text !== tagText) {
          tagText = named.text;
          pill.set(named.text);
          sizeTag();
        }
        tag.position.set(named.x, level + (tag.userData.lift as number), named.z);
      }
      group.visible = guides.length > 0 || !!named;
    },
    setPixelsPerMetre(ppm) {
      if (ppm <= 0) return;
      const lift = tag.userData.lift as number | undefined;
      metresPerPx = 1 / ppm;
      if (tagText) {
        const before = lift ?? 0;
        sizeTag();
        tag.position.y += (tag.userData.lift as number) - before;
      }
    },
    orient(q) {
      tag.quaternion.copy(q);
    },
    dispose() {
      for (const line of lines) {
        line.geometry.dispose();
        line.material.dispose();
      }
      tag.geometry.dispose();
      (tag.material as MeshBasicMaterial).dispose();
      pill.texture.dispose();
    },
  };
}
