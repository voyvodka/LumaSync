import {
  type RoomMapConfig,
  resolveBacklightBinding,
  stripCentre,
  translateStrip,
  type TvAnchorPlacement,
  type UsbStripPlacement,
} from "@/shared/contracts/roomMap";

/** A strip whose middle is this close to the screen's is its backlight, drawn and picked there. */
export const BACKLIGHT_REACH_M = 1.0;

type BacklightSource = { tvAnchor?: RoomMapConfig["tvAnchor"]; usbStrips: readonly UsbStripPlacement[] };

/** An id naming no strip — an undo or a deleted strip can leave one — reads as no binding. */
export function backlightBinding(config: BacklightSource): { strip: UsbStripPlacement } | "none" | "near" {
  const bound = resolveBacklightBinding(config.tvAnchor?.backlightStripId);
  if (bound === null) return "none";
  const strip = bound === undefined ? undefined : config.usbStrips.find((s) => s.stripId === bound);
  return strip ? { strip } : "near";
}

function nearScreen(strip: UsbStripPlacement, tv: TvAnchorPlacement): boolean {
  const { x, y } = stripCentre(strip);
  return Math.hypot(x - (tv.x + tv.width / 2), y - (tv.y + tv.height / 2)) <= BACKLIGHT_REACH_M;
}

export function isBacklightStrip(strip: UsbStripPlacement, config: BacklightSource): boolean {
  const tv = config.tvAnchor;
  if (!tv) return false;
  const binding = backlightBinding(config);
  if (binding === "none") return false;
  return binding === "near" ? nearScreen(strip, tv) : binding.strip.stripId === strip.stripId;
}

/** A bound strip is left to `seatBacklight`; a resize carries nothing. */
export function moveTvWithBacklight(
  strips: readonly UsbStripPlacement[],
  tv: TvAnchorPlacement,
  next: TvAnchorPlacement,
  keepInside: (strip: UsbStripPlacement) => UsbStripPlacement,
): UsbStripPlacement[] | null {
  const dx = next.x - tv.x;
  const dy = next.y - tv.y;
  if ((dx === 0 && dy === 0) || next.width !== tv.width || next.height !== tv.height) return null;
  if (backlightBinding({ tvAnchor: tv, usbStrips: strips }) !== "near") return null;
  let changed = false;
  const moved = strips.map((s) => {
    if (s.locked || !nearScreen(s, tv)) return s;
    changed = true;
    return keepInside(translateStrip(s, dx, dy));
  });
  return changed ? moved : null;
}

/** Null when the bound strip already sits behind the screen or there is none. A lock does not
 *  exempt it: a locked strip left off the screen would still be lit and picked as the backlight. */
export function seatBacklight(
  config: BacklightSource,
  keepInside: (strip: UsbStripPlacement) => UsbStripPlacement,
): UsbStripPlacement[] | null {
  const tv = config.tvAnchor;
  const binding = backlightBinding(config);
  if (!tv || typeof binding === "string") return null;
  const at = stripCentre(binding.strip);
  const seated = keepInside(translateStrip(binding.strip, tv.x + tv.width / 2 - at.x, tv.y + tv.height / 2 - at.y));
  const now = stripCentre(seated);
  if (Math.abs(now.x - at.x) < 1e-6 && Math.abs(now.y - at.y) < 1e-6) return null;
  return config.usbStrips.map((s) => (s === binding.strip ? seated : s));
}
