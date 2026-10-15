import { BufferAttribute, BufferGeometry, Group, Mesh, type Object3D, type Scene } from "three";

export interface Span {
  mesh: Mesh;
  start: number;
  count: number;
}

export interface Liftable {
  spans: Span[];
  extras: Object3D[];
  pivot: { x: number; z: number };
}

export interface LiftedPiece {
  /** What rides on the piece and moves with it, turning with nothing: a desk's monitor. */
  riders: readonly string[];
  moveTo(x: number, z: number): void;
  /** On top of the turn it was built with. */
  turnTo(radians: number): void;
  restore(): void;
}

export function spansOf(mesh: Mesh, counts: readonly number[], owners: readonly (string | null)[], into: (owner: string) => Liftable | undefined) {
  let start = 0;
  counts.forEach((count, i) => {
    const owner = owners[i];
    const liftable = owner ? into(owner) : undefined;
    const last = liftable?.spans[liftable.spans.length - 1];
    if (last && last.mesh === mesh && last.start + last.count === start) last.count += count;
    else liftable?.spans.push({ mesh, start, count });
    start += count;
  });
}

function copySpan({ mesh, start, count }: Span): BufferGeometry {
  const source = mesh.geometry;
  const copy = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const a = attribute as BufferAttribute;
    copy.setAttribute(name, new BufferAttribute(a.array.slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize, a.normalized));
  }
  if (source.index) {
    const index: number[] = [];
    const end = start + count;
    for (const i of source.index.array) if (i >= start && i < end) index.push(i - start);
    copy.setIndex(index);
  }
  return copy;
}

/** Copied out and collapsed onto the origin, a zero-area point, so nothing is rebuilt while carried. */
export function liftPiece(scene: Scene, piece: Liftable, riders: ReadonlyMap<string, Liftable> = new Map()): LiftedPiece {
  const carried = [...riders].map(([id, rider]) => ({ id, rider, lifted: liftPiece(scene, rider) }));
  const pivot = new Group();
  pivot.position.set(piece.pivot.x, 0, piece.pivot.z);
  const inner = new Group();
  inner.position.set(-piece.pivot.x, 0, -piece.pivot.z);
  pivot.add(inner);
  const saved = piece.spans.map((span) => {
    const copy = new Mesh(copySpan(span), span.mesh.material);
    copy.castShadow = span.mesh.castShadow;
    copy.receiveShadow = span.mesh.receiveShadow;
    copy.renderOrder = span.mesh.renderOrder;
    inner.add(copy);
    const position = span.mesh.geometry.getAttribute("position") as BufferAttribute;
    const from = span.start * 3;
    const length = span.count * 3;
    const kept = position.array.slice(from, from + length);
    position.array.fill(0, from, from + length);
    position.addUpdateRange(from, length);
    position.needsUpdate = true;
    return { span, kept, copy };
  });
  for (const extra of piece.extras) inner.add(extra);
  scene.add(pivot);
  return {
    riders: carried.map(({ id }) => id),
    moveTo(x, z) {
      pivot.position.x = x;
      pivot.position.z = z;
      for (const { rider, lifted } of carried) lifted.moveTo(rider.pivot.x + x - piece.pivot.x, rider.pivot.z + z - piece.pivot.z);
    },
    turnTo(radians) {
      pivot.rotation.y = -radians;
    },
    restore() {
      for (const { lifted } of carried) lifted.restore();
      for (const extra of piece.extras) scene.add(extra);
      pivot.removeFromParent();
      for (const { span, kept, copy } of saved) {
        copy.geometry.dispose();
        const position = span.mesh.geometry.getAttribute("position") as BufferAttribute;
        position.array.set(kept, span.start * 3);
        position.addUpdateRange(span.start * 3, kept.length);
        position.needsUpdate = true;
      }
    },
  };
}
