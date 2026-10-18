export interface FanPoint {
  id: number;
  x: number;
  y: number;
}

/**
 * Offsets that spread points lying on top of each other around their shared spot, so each can be
 * seen and grabbed: four lights a bridge reports at the same place drew as one disc. Points within
 * `near` of a stack's first point join it; a stack of n sits on a ring of at least `radius`, wide
 * enough that neighbours keep `spacing` apart. Lone points get no entry.
 */
export function fanOutStacked(
  points: readonly FanPoint[],
  { near, radius, spacing }: { near: number; radius: number; spacing: number },
): Map<number, { dx: number; dy: number }> {
  const offsets = new Map<number, { dx: number; dy: number }>();
  const taken = new Set<number>();
  for (const p of points) {
    if (taken.has(p.id)) continue;
    const stack = points.filter((q) => !taken.has(q.id) && Math.hypot(q.x - p.x, q.y - p.y) <= near);
    for (const q of stack) taken.add(q.id);
    if (stack.length < 2) continue;
    const r = Math.max(radius, (stack.length * spacing) / (2 * Math.PI));
    stack.forEach((q, i) => {
      // From the top, clockwise, so the order reads like a clock face.
      const a = -Math.PI / 2 + (2 * Math.PI * i) / stack.length;
      offsets.set(q.id, { dx: p.x - q.x + r * Math.cos(a), dy: p.y - q.y + r * Math.sin(a) });
    });
  }
  return offsets;
}
