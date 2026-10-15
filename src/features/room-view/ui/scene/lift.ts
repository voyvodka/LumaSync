import { BufferAttribute, BufferGeometry, Group, Mesh, type Object3D, type Scene } from "three";

/** Where one object's vertices sit in a merged mesh. */
export interface Span {
  mesh: Mesh;
  start: number;
  count: number;
}

/** What a carried object is made of: its share of the merged meshes and the meshes of its own. */
export interface Liftable {
  spans: Span[];
  extras: Object3D[];
  pivot: { x: number; z: number };
}

export interface LiftedPiece {
  moveTo(x: number, z: number): void;
  /** On top of the turn it was built with. */
  turnTo(radians: number): void;
  /** Back where it was picked up, in the merged meshes again. */
  restore(): void;
}

/** Spans laid end to end, one per part, skipping the parts no one owns. */
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

/** The vertices of a span, and the triangles of an indexed mesh that use only them. */
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

/**
 * Takes an object out of the merged meshes into a group of its own that can follow the pointer:
 * its vertices are copied out and collapsed to a point where they were, so nothing is rebuilt while
 * it is carried. The scene built from the landed room replaces both.
 */
export function liftPiece(scene: Scene, piece: Liftable): LiftedPiece {
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
    moveTo(x, z) {
      pivot.position.x = x;
      pivot.position.z = z;
    },
    turnTo(radians) {
      pivot.rotation.y = -radians;
    },
    restore() {
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
