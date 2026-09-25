import { MODE_KIND_ORDER, modeKind } from "@/features/mode/model/modeKinds";
import type { LightingModeConfig, LightingModeKind } from "@/shared/contracts/mode";

import type { KeybindHandlers } from "./useGlobalKeybinds";

/**
 * ⌥1–⌥3, as the mode buttons they stand for: the same `changeMode` a click
 * runs, and nothing while that button is disabled. Read at press time, so a handler map
 * built once never acts on a stale answer.
 */
export function modeKeybindHandlers(
  changeMode: (next: LightingModeConfig) => void,
  isDisabled: (kind: LightingModeKind) => boolean,
): KeybindHandlers {
  const handlers: KeybindHandlers = {};
  for (const kind of MODE_KIND_ORDER) {
    const descriptor = modeKind(kind);
    handlers[descriptor.keybind] = () => {
      if (isDisabled(kind)) return;
      // The kind alone: Rust keeps the last colour and Ambilight settings.
      changeMode(descriptor.config({}));
    };
  }
  return handlers;
}
