/**
 * Packed `0xRRGGBB` LED colour. The edge-signal stream deserialises a fresh
 * `[r, g, b]` triple every frame, so triples defeat `React.memo` by reference;
 * a packed integer compares by value and dots only re-render on real change.
 */
export type PackedLedColor = number;

const CHANNEL_MAX = 255;

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= CHANNEL_MAX) return CHANNEL_MAX;
  return value | 0;
}

export function packLedColor(rgb: readonly [number, number, number]): PackedLedColor {
  return (clampChannel(rgb[0]) << 16) | (clampChannel(rgb[1]) << 8) | clampChannel(rgb[2]);
}

export function unpackRed(packed: PackedLedColor): number {
  return (packed >> 16) & 0xff;
}

export function unpackGreen(packed: PackedLedColor): number {
  return (packed >> 8) & 0xff;
}

export function unpackBlue(packed: PackedLedColor): number {
  return packed & 0xff;
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` from a packed colour. */
export function packedToCss(packed: PackedLedColor, alpha?: number): string {
  const r = unpackRed(packed);
  const g = unpackGreen(packed);
  const b = unpackBlue(packed);
  return alpha === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const EMPTY_PACKED_BUFFER: readonly PackedLedColor[] = Object.freeze([]);

/**
 * Packs a frame's LED buffer, returning `previous` **by reference** when the
 * contents are unchanged — a static pattern then keeps every downstream
 * `useMemo` and memo'd dot on its bail-out path.
 */
export function packLedBuffer(
  source: ReadonlyArray<readonly [number, number, number]> | undefined,
  previous: readonly PackedLedColor[],
): readonly PackedLedColor[] {
  if (!source || source.length === 0) {
    return previous.length === 0 ? previous : EMPTY_PACKED_BUFFER;
  }
  const next = new Array<PackedLedColor>(source.length);
  let identical = previous.length === source.length;
  for (let i = 0; i < source.length; i += 1) {
    next[i] = packLedColor(source[i]);
    if (identical && previous[i] !== next[i]) identical = false;
  }
  return identical ? previous : next;
}
