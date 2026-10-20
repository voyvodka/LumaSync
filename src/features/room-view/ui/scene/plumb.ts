// Where a light high in the room stands on the plan: a dashed line down to the floor and a ring
// there, so a ceiling light's place reads against the floor and the furniture under it.
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Line, LineDashedMaterial, Mesh, MeshBasicMaterial, RingGeometry } from "three";

/** Below this, a light's floor is close enough to read without a guide. */
export const PLUMB_FROM = 1.2;
export const PLUMB_NAME = "plumb";
const RING = 0.12;
const FLOOR_LIFT = 0.007;

export interface Plumb {
  group: Group;
  /** Moves the line's top, where the light's lit part ends. */
  setTop(top: number): void;
  dispose(): void;
}

/** A guide from `top` down to the floor at the group's origin; place the group at the light's x, z. */
export function plumbGuide(top: number, colour: number, opacity = 0.75): Plumb {
  const group = new Group();
  group.name = PLUMB_NAME;
  const line = new BufferGeometry();
  line.setAttribute("position", new Float32BufferAttribute([0, top, 0, 0, FLOOR_LIFT, 0], 3));
  const dashes = new LineDashedMaterial({ color: colour, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity, depthWrite: false, toneMapped: false });
  const drop = new Line(line, dashes);
  drop.computeLineDistances();
  const setTop = (next: number) => {
    const position = line.getAttribute("position") as Float32BufferAttribute;
    position.setY(0, next);
    position.needsUpdate = true;
    line.computeBoundingSphere();
    drop.computeLineDistances();
  };
  const ring = new RingGeometry(RING * 0.78, RING, 40);
  const ringMaterial = new MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false, toneMapped: false, side: DoubleSide });
  const mark = new Mesh(ring, ringMaterial);
  mark.rotation.x = -Math.PI / 2;
  mark.position.y = FLOOR_LIFT;
  group.add(drop, mark);
  return {
    group,
    setTop,
    dispose() {
      line.dispose();
      dashes.dispose();
      ring.dispose();
      ringMaterial.dispose();
    },
  };
}
