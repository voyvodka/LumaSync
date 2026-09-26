import type { TFunction } from "i18next";

import type { DisplayInfo } from "@/shared/contracts/display";

// What tao reports on macOS when the display has no name of its own: the CoreGraphics id.
const GENERATED = /^Monitor #\d+$/;

/**
 * A display's name as a person would say it. A generated name ("Monitor #41057") becomes the main
 * display, or "Display N" for the others: numbered from 2 left to right, the main one being 1.
 */
export function displayName(display: DisplayInfo, displays: readonly DisplayInfo[], t: TFunction): string {
  const label = display.label.trim();
  if (label && !GENERATED.test(label)) return label;
  if (display.isPrimary) return t("calibration:setup.displayMain");
  const others = displays.filter((d) => !d.isPrimary).sort((a, b) => a.x - b.x || a.y - b.y);
  return t("calibration:setup.displayN", { n: others.findIndex((d) => d.id === display.id) + 2 });
}
