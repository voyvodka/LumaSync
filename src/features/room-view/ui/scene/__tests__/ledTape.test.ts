import { InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { CHIP_DETAIL_PX, ledTape } from "../ledTape";

const parts = (length: number, leds: number) => {
  const tape = ledTape(length, leds, false, new MeshBasicMaterial());
  const chips = tape.group.children.find((o): o is InstancedMesh => o instanceof InstancedMesh)!;
  const line = tape.group.children.find((o): o is Mesh => o instanceof Mesh && !(o instanceof InstancedMesh) && o.layers.mask !== 1)!;
  return { tape, chips, line };
};

describe("ledTape", () => {
  // Up close a 60-LED strip read as one bar; the maintainer wants to see the 60.
  it("draws one chip per LED saved, spread evenly along the tape", () => {
    const { chips } = parts(1, 60);
    expect(chips.count).toBe(60);
    const at = (i: number) => {
      const m = new Matrix4();
      chips.getMatrixAt(i, m);
      return new Vector3().setFromMatrixPosition(m);
    };
    expect(at(0).x).toBeCloseTo(-0.5 + 1 / 120);
    expect(at(59).x).toBeCloseTo(0.5 - 1 / 120);
  });

  it("shows the line from afar and the LEDs once their pitch spans a few pixels", () => {
    const { tape, chips, line } = parts(1, 60);
    expect(line.visible).toBe(true);
    expect(chips.visible).toBe(false);
    const closeEnough = (CHIP_DETAIL_PX * 60) / 1;
    expect(tape.setPixelsPerMetre(closeEnough - 1)).toBe(false);
    expect(tape.setPixelsPerMetre(closeEnough)).toBe(true);
    expect(chips.visible).toBe(true);
    expect(line.visible).toBe(false);
  });
});
