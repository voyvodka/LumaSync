import {
  fitStripLength,
  type RoomMapConfig,
  resolveStripDensity,
  stripLengthFromDensity,
  stripRunLength,
  type UsbStripPlacement,
} from "@/shared/contracts/roomMap";

import { isBacklightStrip } from "./backlight";

/**
 * `after` refit to its LEDs at its density when the edit gave it a new LED count or density. A patch
 * naming the same count changes nothing (Onto the wall sends the whole strip), and the TV's
 * backlight keeps its run: its count is the screen's perimeter, and refit it would leave the screen.
 */
export function refitRetapedStrip<T extends UsbStripPlacement>(before: UsbStripPlacement, after: T, config: Pick<RoomMapConfig, "tvAnchor" | "usbStrips">): T {
  const retaped = after.ledCount !== before.ledCount || resolveStripDensity(after) !== resolveStripDensity(before);
  if (!retaped || isBacklightStrip(before, config)) return after;
  return fitStripLength(after);
}

/** The length the strip's card offers to fit it to: its LEDs at its density, when the drawn run is
 *  more than a centimetre off it and the strip can take it (not locked, not the backlight, a run to
 *  follow). */
export function stripFitOffer(strip: UsbStripPlacement, config: Pick<RoomMapConfig, "tvAnchor" | "usbStrips">): number | undefined {
  const fitTo = stripLengthFromDensity(strip);
  if (fitTo === undefined || strip.locked || isBacklightStrip(strip, config)) return undefined;
  const run = stripRunLength(strip);
  return run > 1e-6 && Math.abs(run - fitTo) > 0.01 ? fitTo : undefined;
}
