// A USB strip as its tape: from across the room one lit line, close enough that its LEDs stand apart
// on screen, the dark tape with each LED a chip of its own — 60 LEDs saved, 60 drawn.
import { BoxGeometry, Group, InstancedMesh, type Material, Matrix4, Mesh, MeshBasicMaterial } from "three";

import { BLOOM_LAYER } from "./bloom";

/** The tape is about a centimetre wide and a few millimetres deep. */
export const TAPE_WIDTH = 0.012;
export const TAPE_DEPTH = 0.004;
/** An LED chip is a 5050 package: 5 mm square. */
const CHIP = 0.005;
/** Pitch on screen past which LEDs are drawn one by one; at 6 the overview broke a strip into dashes. */
export const CHIP_DETAIL_PX = 12;
const TAPE_COLOUR = 0x1c1c20;
/** From afar the line keeps this width on screen: at its true centimetre it fell under a pixel and
 *  broke into dashes. */
const LINE_MIN_PX = 2;

export interface LedTape {
  group: Group;
  /** Draws the LEDs apart or as one line for the view's scale; true when that changed. */
  setPixelsPerMetre(ppm: number): boolean;
}

/**
 * `length` along local x, centred on the origin; `lying` lays it flat on the floor, else it stands
 * flat against a wall. `lit` is the strip's glow, shared with the line so a mood paints both.
 */
export function ledTape(length: number, ledCount: number, lying: boolean, lit: Material): LedTape {
  const size = (along: number, across: number, deep: number) => (lying ? new BoxGeometry(along, deep, across) : new BoxGeometry(along, across, deep));
  const group = new Group();

  const line = new Mesh(size(length, TAPE_WIDTH, TAPE_DEPTH), lit);
  line.layers.enable(BLOOM_LAYER);

  const tape = new Mesh(size(length, TAPE_WIDTH, TAPE_DEPTH * 0.6), new MeshBasicMaterial({ color: TAPE_COLOUR }));
  const count = Math.max(1, Math.round(ledCount));
  const pitch = length / count;
  const chips = new InstancedMesh(size(Math.min(CHIP, pitch * 0.7), Math.min(CHIP, TAPE_WIDTH * 0.6), TAPE_DEPTH), lit, count);
  chips.layers.enable(BLOOM_LAYER);
  const at = new Matrix4();
  for (let i = 0; i < count; i++) chips.setMatrixAt(i, at.makeTranslation(-length / 2 + pitch * (i + 0.5), 0, 0));
  chips.instanceMatrix.needsUpdate = true;

  group.add(line, tape, chips);
  let detailed: boolean | null = null;
  const setPixelsPerMetre = (ppm: number) => {
    const thicken = ppm > 0 ? Math.max(1, LINE_MIN_PX / ppm / TAPE_WIDTH) : 1;
    if (lying) line.scale.set(1, 1, thicken);
    else line.scale.set(1, thicken, 1);
    const next = pitch * ppm >= CHIP_DETAIL_PX;
    if (next === detailed) return false;
    detailed = next;
    line.visible = !next;
    tape.visible = next;
    chips.visible = next;
    return true;
  };
  setPixelsPerMetre(0);
  return { group, setPixelsPerMetre };
}
