// A piece on the plan as its box: `x`/`y` the unrotated top-left, `w` across and `h` deep, turned `r`
// degrees about its centre, all in room metres.
export interface PieceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Half the width and depth of what the turned box covers on the plan. */
export function coveredHalf(box: Pick<PieceBox, "w" | "h" | "r">): { hx: number; hy: number } {
  const t = (box.r * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { hx: (box.w * c + box.h * s) / 2, hy: (box.w * s + box.h * c) / 2 };
}

/** The box moved, not resized, so what it covers stays inside the room; one larger than the room is centred. */
export function clampInsideRoom(box: PieceBox, room: { width: number; depth: number }): PieceBox {
  const { hx, hy } = coveredHalf(box);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = hx * 2 >= room.width ? room.width / 2 : Math.min(Math.max(cx, hx), room.width - hx);
  const ny = hy * 2 >= room.depth ? room.depth / 2 : Math.min(Math.max(cy, hy), room.depth - hy);
  return { ...box, x: nx - box.w / 2, y: ny - box.h / 2 };
}

export function snapToStep(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/**
 * The box after a handle with signs `sx`/`sy` travelled (`dx`, `dy`) metres on the plan: it grows
 * along the handle's own axes and the opposite side or corner stays where it was. ⇧ keeps the
 * proportions from a corner; sizes land on `step` when it is set.
 */
export function resizeFromHandle(
  start: PieceBox,
  signs: { sx: -1 | 0 | 1; sy: -1 | 0 | 1 },
  dx: number,
  dy: number,
  options: { min: number; step: number; keepRatio: boolean },
): PieceBox {
  const t = (start.r * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // The travel in the piece's own axes.
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  let w = signs.sx === 0 ? start.w : start.w + signs.sx * lx;
  let h = signs.sy === 0 ? start.h : start.h + signs.sy * ly;
  if (options.keepRatio && signs.sx !== 0 && signs.sy !== 0) {
    const k = Math.max(w / start.w, h / start.h);
    w = start.w * k;
    h = start.h * k;
  }
  w = Math.max(options.min, snapToStep(w, options.step));
  h = Math.max(options.min, snapToStep(h, options.step));
  // The fixed point: the side or corner opposite the handle, in the plan's frame.
  const ax = (-signs.sx * start.w) / 2;
  const ay = (-signs.sy * start.h) / 2;
  const cx0 = start.x + start.w / 2;
  const cy0 = start.y + start.h / 2;
  const anchorX = cx0 + ax * cos - ay * sin;
  const anchorY = cy0 + ax * sin + ay * cos;
  const bx = (-signs.sx * w) / 2;
  const by = (-signs.sy * h) / 2;
  const cx = anchorX - (bx * cos - by * sin);
  const cy = anchorY - (bx * sin + by * cos);
  return { ...start, x: cx - w / 2, y: cy - h / 2, w, h };
}
