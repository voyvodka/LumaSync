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

/** A piece carried in the 3D room and put down with its middle at (`centreX`, `centreY`) on the
 *  plan, turned `turnDeg` more: it lands inside the room, to the centimetre. */
export function landCarriedPiece<T extends { x: number; y: number; width: number; height: number; rotation?: number }>(
  piece: T,
  centreX: number,
  centreY: number,
  turnDeg: number,
  room: { width: number; depth: number },
): T {
  const rotation = ((((piece.rotation ?? 0) + turnDeg) % 360) + 360) % 360;
  const box = clampInsideRoom(
    { x: centreX - piece.width / 2, y: centreY - piece.height / 2, w: piece.width, h: piece.height, r: rotation },
    room,
  );
  return { ...piece, x: Math.round(box.x * 100) / 100, y: Math.round(box.y * 100) / 100, rotation };
}

export interface RoomBox {
  width: number;
  depth: number;
}

export function roomBoxOf(config: { dimensions: { widthMeters: number; depthMeters: number } }): RoomBox {
  return { width: config.dimensions.widthMeters, depth: config.dimensions.depthMeters };
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A placed rectangle (furniture, the TV) kept inside the room whatever put it there — a typed X of
 * −5 sent a sofa off the plan, out of reach of the pointer. A square-turned piece longer than the
 * room is cut to it first; at any other angle one too big is centred.
 */
export function keepPlacedInside<T extends { x: number; y: number; width: number; height: number; rotation?: number }>(
  piece: T,
  room: RoomBox,
): T {
  const r = (((piece.rotation ?? 0) % 360) + 360) % 360;
  let { width, height } = piece;
  if (r % 180 === 0) {
    width = Math.min(width, room.width);
    height = Math.min(height, room.depth);
  } else if (r % 180 === 90) {
    width = Math.min(width, room.depth);
    height = Math.min(height, room.width);
  }
  const box = clampInsideRoom({ x: piece.x, y: piece.y, w: width, h: height, r }, room);
  const next = { ...piece, x: mm(box.x), y: mm(box.y), width: mm(width), height: mm(height) };
  return next.x === piece.x && next.y === piece.y && next.width === piece.width && next.height === piece.height
    ? piece
    : next;
}

/** A strip slid, whole, so both its ends are inside the room; one longer than the room starts at
 *  its near wall. */
export function keepStripInside<T extends { startX: number; startY: number; endX: number; endY: number }>(
  strip: T,
  room: RoomBox,
): T {
  const shift = (a: number, b: number, span: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo < 0 || hi - lo > span) return -lo;
    return hi > span ? span - hi : 0;
  };
  const dx = shift(strip.startX, strip.endX, room.width);
  const dy = shift(strip.startY, strip.endY, room.depth);
  if (dx === 0 && dy === 0) return strip;
  return {
    ...strip,
    startX: mm(strip.startX + dx),
    endX: mm(strip.endX + dx),
    startY: mm(strip.startY + dy),
    endY: mm(strip.endY + dy),
  };
}
