import type { TvAnchorPlacement, UsbStripPlacement } from "@/shared/contracts/roomMap";

/** A strip whose middle is this close to the screen's is its backlight, drawn and picked there. */
export const BACKLIGHT_REACH_M = 1.0;

export function isBacklightStrip(strip: UsbStripPlacement, tv: TvAnchorPlacement): boolean {
  const mx = (strip.startX + strip.endX) / 2;
  const my = (strip.startY + strip.endY) / 2;
  return Math.hypot(mx - (tv.x + tv.width / 2), my - (tv.y + tv.height / 2)) <= BACKLIGHT_REACH_M;
}

/** The TV put at `next`, its backlight strips carried by the same move so they stay its backlight.
 *  A resize moves no strip. */
export function moveTvWithBacklight(
  strips: readonly UsbStripPlacement[],
  tv: TvAnchorPlacement,
  next: TvAnchorPlacement,
  keepInside: (strip: UsbStripPlacement) => UsbStripPlacement,
): UsbStripPlacement[] | null {
  const dx = next.x - tv.x;
  const dy = next.y - tv.y;
  if ((dx === 0 && dy === 0) || next.width !== tv.width || next.height !== tv.height) return null;
  let changed = false;
  const moved = strips.map((s) => {
    if (s.locked || !isBacklightStrip(s, tv)) return s;
    changed = true;
    return keepInside({ ...s, startX: s.startX + dx, startY: s.startY + dy, endX: s.endX + dx, endY: s.endY + dy });
  });
  return changed ? moved : null;
}
