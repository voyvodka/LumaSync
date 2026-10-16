import { BufferAttribute, BufferGeometry, Group, type Material, Mesh, type MeshBasicMaterial, type Object3D, type Scene } from "three";

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
  /** Where it was built, in the scene. */
  pivot: { readonly x: number; readonly z: number };
  moveTo(x: number, z: number): void;
  /** On top of the turn it was built with. */
  turnTo(radians: number): void;
  /** Scaled across and up about the height `aboutY`, then raised: a screen resized in place. */
  reshape(scaleX: number, scaleY: number, aboutY: number, raise: number): void;
  restore(): void;
  /** Into another scene, for a piece that outlives the room it was lifted from. */
  rehome(scene: Scene): void;
  /** Gone for good, nothing written back: the room it came from is gone too. */
  discard(): void;
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

/** Hides the spans by folding their points to the origin, as a lift does, and brings them back. */
export function spanHider(spans: readonly Span[]): (hidden: boolean) => void {
  let kept: Float32Array[] | null = null;
  return (hidden) => {
    if (hidden === (kept !== null)) return;
    if (hidden) {
      kept = spans.map(({ mesh, start, count }) => {
        const position = mesh.geometry.getAttribute("position") as BufferAttribute;
        const saved = (position.array as Float32Array).slice(start * 3, (start + count) * 3);
        position.array.fill(0, start * 3, (start + count) * 3);
        position.addUpdateRange(start * 3, count * 3);
        position.needsUpdate = true;
        return saved;
      });
      return;
    }
    spans.forEach(({ mesh, start, count }, i) => {
      const position = mesh.geometry.getAttribute("position") as BufferAttribute;
      (position.array as Float32Array).set(kept![i]!, start * 3);
      position.addUpdateRange(start * 3, count * 3);
      position.needsUpdate = true;
    });
    kept = null;
  };
}

function disposeMaterials(node: Object3D) {
  if (!(node instanceof Mesh)) return;
  const materials: Material[] = Array.isArray(node.material) ? node.material : [node.material];
  for (const material of materials) {
    (material as MeshBasicMaterial).map?.dispose();
    material.dispose();
  }
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
export function liftPiece(home: Scene, piece: Liftable, riders: ReadonlyMap<string, Liftable> = new Map()): LiftedPiece {
  let scene = home;
  const carried = [...riders].map(([id, rider]) => ({ id, rider, lifted: liftPiece(scene, rider) }));
  const pivot = new Group();
  pivot.position.set(piece.pivot.x, 0, piece.pivot.z);
  const stretch = new Group();
  pivot.add(stretch);
  const inner = new Group();
  inner.position.set(-piece.pivot.x, 0, -piece.pivot.z);
  stretch.add(inner);
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
    pivot: { x: piece.pivot.x, z: piece.pivot.z },
    moveTo(x, z) {
      pivot.position.x = x;
      pivot.position.z = z;
      for (const { rider, lifted } of carried) lifted.moveTo(rider.pivot.x + x - piece.pivot.x, rider.pivot.z + z - piece.pivot.z);
    },
    turnTo(radians) {
      pivot.rotation.y = -radians;
    },
    reshape(scaleX, scaleY, aboutY, raise) {
      stretch.scale.set(scaleX, scaleY, 1);
      stretch.position.y = aboutY + raise;
      inner.position.y = -aboutY;
    },
    rehome(next) {
      for (const { lifted } of carried) lifted.rehome(next);
      scene = next;
      next.add(pivot);
    },
    discard() {
      for (const { lifted } of carried) lifted.discard();
      pivot.removeFromParent();
      pivot.traverse((node) => {
        if (node instanceof Mesh) node.geometry.dispose();
      });
      // The copies borrow the merged meshes' materials, gone with their scene; an extra owns its own.
      for (const extra of piece.extras) extra.traverse(disposeMaterials);
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
