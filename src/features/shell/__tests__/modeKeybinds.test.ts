import { describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig, type LightingModeKind } from "@/shared/contracts/mode";
import { KEYBIND_ACTIONS } from "@/shared/contracts/shell";

import { modeKeybindHandlers } from "../modeKeybinds";

describe("modeKeybindHandlers", () => {
  it("runs the same changeMode a mode click does, with the kind alone", () => {
    const changeMode = vi.fn<(next: LightingModeConfig) => void>();
    const handlers = modeKeybindHandlers(changeMode, () => false);

    handlers[KEYBIND_ACTIONS.MODE_AMBILIGHT]?.();
    handlers[KEYBIND_ACTIONS.MODE_SOLID]?.();
    handlers[KEYBIND_ACTIONS.MODE_OFF]?.();

    expect(changeMode.mock.calls.map(([config]) => config)).toEqual([
      { kind: LIGHTING_MODE_KIND.AMBILIGHT },
      { kind: LIGHTING_MODE_KIND.SOLID },
      { kind: LIGHTING_MODE_KIND.OFF },
    ]);
  });

  // ⌥2 used to start Ambilight beside a dimmed Ambilight button.
  it("does nothing for a kind whose button is disabled, and still runs the others", () => {
    const changeMode = vi.fn<(next: LightingModeConfig) => void>();
    const disabled = new Set<LightingModeKind>([LIGHTING_MODE_KIND.AMBILIGHT, LIGHTING_MODE_KIND.SOLID]);
    const handlers = modeKeybindHandlers(changeMode, (kind) => disabled.has(kind));

    handlers[KEYBIND_ACTIONS.MODE_AMBILIGHT]?.();
    handlers[KEYBIND_ACTIONS.MODE_SOLID]?.();
    expect(changeMode).not.toHaveBeenCalled();

    handlers[KEYBIND_ACTIONS.MODE_OFF]?.();
    expect(changeMode).toHaveBeenCalledWith({ kind: LIGHTING_MODE_KIND.OFF });
  });

  it("asks at press time, so a map built earlier follows the button", () => {
    const changeMode = vi.fn<(next: LightingModeConfig) => void>();
    let blocked = true;
    const handlers = modeKeybindHandlers(changeMode, () => blocked);

    handlers[KEYBIND_ACTIONS.MODE_SOLID]?.();
    blocked = false;
    handlers[KEYBIND_ACTIONS.MODE_SOLID]?.();

    expect(changeMode).toHaveBeenCalledOnce();
  });
});
