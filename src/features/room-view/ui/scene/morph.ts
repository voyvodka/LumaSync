import type { MorphPlan } from "../../model/templateMorph";
import type { LiftedPiece } from "./lift";

const GLIDE_MS = 560;
const SINK_MS = 300;
const RISE_MS = 380;
const RISE_STAGGER_MS = 40;
// The last piece of a full room still rises inside the glide's settle, not long after it.
const RISE_STAGGER_CAP_MS = 420;
// A scale of exactly 0 has no inverse, and the normals of a flattened piece go NaN.
const FLAT = 0.001;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

export interface Morph {
  /** Poses every piece for `now`; false once all of them have arrived. */
  step(now: number): boolean;
  finish(): void;
}

/** `leaving` were lifted from the old scene before it was disposed, and rehomed into the new one. */
export function startMorph(plan: MorphPlan, lift: (objectId: string) => LiftedPiece | null, leaving: readonly LiftedPiece[], start: number): Morph {
  const gliding = plan.matched.flatMap(({ from, to }) => {
    const lifted = lift(to.objectId);
    if (!lifted) return [];
    return [{ lifted, dx: from.x - to.x, dz: from.z - to.z, turn: ((((from.rotation - to.rotation + 540) % 360) - 180) * Math.PI) / 180, stretch: from.width / Math.max(to.width, 0.01) }];
  });
  const rising = plan.arriving.flatMap((piece, i) => {
    const lifted = lift(piece.objectId);
    return lifted ? [{ lifted, delay: Math.min(i * RISE_STAGGER_MS, RISE_STAGGER_CAP_MS) }] : [];
  });
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    for (const { lifted } of gliding) lifted.restore();
    for (const { lifted } of rising) lifted.restore();
    for (const lifted of leaving) lifted.discard();
  };

  const step = (now: number) => {
    if (done) return false;
    const t = now - start;
    const k = easeInOut(clamp01(t / GLIDE_MS));
    for (const { lifted, dx, dz, turn, stretch } of gliding) {
      lifted.moveTo(lifted.pivot.x + dx * (1 - k), lifted.pivot.z + dz * (1 - k));
      lifted.turnTo(turn * (1 - k));
      lifted.reshape(stretch + (1 - stretch) * k, 1, 0, 0);
    }
    const sunk = easeOut(clamp01(t / SINK_MS));
    for (const lifted of leaving) lifted.reshape(1, Math.max(1 - sunk, FLAT), 0, 0);
    for (const { lifted, delay } of rising) lifted.reshape(1, Math.max(easeOut(clamp01((t - delay) / RISE_MS)), FLAT), 0, 0);
    const last = Math.max(GLIDE_MS, SINK_MS, (rising[rising.length - 1]?.delay ?? 0) + RISE_MS);
    if (t < last) return true;
    finish();
    return false;
  };

  step(start);
  return { step, finish };
}
