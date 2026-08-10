/**
 * ledColor — packing helpers behind the twin overlay's memo bail-out.
 *
 * Covers:
 *   - Round-trip packing of every channel, including clamping of out-of-range
 *     and non-finite input.
 *   - `packedToCss` emits rgb() without alpha and rgba() with it.
 *   - `packLedBuffer` returns the PREVIOUS array by reference when the packed
 *     contents are unchanged (this reference stability is what lets the
 *     downstream `useMemo`/`memo` bail out).
 *   - A single changed channel breaks that reference equality.
 *   - Length changes break it too, even when the shared prefix matches.
 *   - An empty/absent source collapses to the shared frozen empty buffer.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_PACKED_BUFFER,
  packLedBuffer,
  packLedColor,
  packedToCss,
  unpackBlue,
  unpackGreen,
  unpackRed,
} from "../ledColor";

type Rgb = [number, number, number];

describe("packLedColor / unpack*", () => {
  it("round-trips each channel independently", () => {
    const packed = packLedColor([12, 34, 56]);
    expect(unpackRed(packed)).toBe(12);
    expect(unpackGreen(packed)).toBe(34);
    expect(unpackBlue(packed)).toBe(56);
  });

  it("packs pure white and pure black to the 24-bit extremes", () => {
    expect(packLedColor([255, 255, 255])).toBe(0xffffff);
    expect(packLedColor([0, 0, 0])).toBe(0);
  });

  it("clamps out-of-range and non-finite channels instead of corrupting neighbours", () => {
    const packed = packLedColor([300, -20, Number.NaN]);
    expect(unpackRed(packed)).toBe(255);
    expect(unpackGreen(packed)).toBe(0);
    expect(unpackBlue(packed)).toBe(0);
  });

  it("truncates fractional channels rather than bleeding into the next byte", () => {
    const packed = packLedColor([10.9, 20.4, 30.5]);
    expect([unpackRed(packed), unpackGreen(packed), unpackBlue(packed)]).toEqual([10, 20, 30]);
  });
});

describe("packedToCss", () => {
  it("emits rgb() when no alpha is supplied", () => {
    expect(packedToCss(packLedColor([1, 2, 3]))).toBe("rgb(1, 2, 3)");
  });

  it("emits rgba() when an alpha is supplied", () => {
    expect(packedToCss(packLedColor([1, 2, 3]), 0.55)).toBe("rgba(1, 2, 3, 0.55)");
  });
});

describe("packLedBuffer", () => {
  const frameA: Rgb[] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];

  it("returns the previous reference when a fresh array carries identical colours", () => {
    const first = packLedBuffer(frameA, EMPTY_PACKED_BUFFER);
    // A new array with the same values — exactly what the 10 Hz event stream
    // hands us for a static pattern.
    const second = packLedBuffer(
      frameA.map((c) => [...c] as Rgb),
      first,
    );
    expect(second).toBe(first);
  });

  it("returns a new reference when a single channel moves", () => {
    const first = packLedBuffer(frameA, EMPTY_PACKED_BUFFER);
    const changed: Rgb[] = [
      [255, 0, 0],
      [0, 254, 0],
      [0, 0, 255],
    ];
    const second = packLedBuffer(changed, first);
    expect(second).not.toBe(first);
    expect(second[1]).toBe(packLedColor([0, 254, 0]));
  });

  it("returns a new reference when the LED count changes on a matching prefix", () => {
    const first = packLedBuffer(frameA, EMPTY_PACKED_BUFFER);
    const second = packLedBuffer([...frameA, [9, 9, 9] as Rgb], first);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(4);
  });

  it("collapses an absent or empty source to the shared empty buffer", () => {
    const first = packLedBuffer(frameA, EMPTY_PACKED_BUFFER);
    expect(packLedBuffer(undefined, first)).toBe(EMPTY_PACKED_BUFFER);
    expect(packLedBuffer([], first)).toBe(EMPTY_PACKED_BUFFER);
    // Already empty: stay on the same reference rather than churning.
    expect(packLedBuffer(undefined, EMPTY_PACKED_BUFFER)).toBe(EMPTY_PACKED_BUFFER);
  });
});
