import type { KeybindPlatform } from "@/shared/contracts/shell";

export type ZoomAction = "in" | "out" | "reset";

export const ZOOM_ACTIONS: readonly ZoomAction[] = ["in", "out", "reset"];

/**
 * By `event.key`, unlike the mode keys: `+` and `-` sit on different physical keys per layout (on
 * TR-Q `-` is the key whose code is `Equal`), and a printed character is what the badge promises.
 * Shift is allowed because `+` needs it on most layouts.
 */
const KEYS: Readonly<Record<string, ZoomAction>> = {
  "=": "in",
  "+": "in",
  "-": "out",
  _: "out",
  "0": "reset",
};

export function zoomActionFor(event: KeyboardEvent, platform: KeybindPlatform): ZoomAction | null {
  const primary = platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary || event.altKey) return null;
  return KEYS[event.key] ?? null;
}

export function zoomBadges(platform: KeybindPlatform): Readonly<Record<ZoomAction, string[]>> {
  const mod = platform === "macos" ? "⌘" : "Ctrl";
  return { in: [mod, "+"], out: [mod, "−"], reset: [mod, "0"] };
}
