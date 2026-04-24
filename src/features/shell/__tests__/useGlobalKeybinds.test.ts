/**
 * useGlobalKeybinds — hook contract tests.
 *
 * Covers:
 *  - Alt+Digit1 on the `default` (Windows/Linux) platform dispatches
 *    the MODE_OFF handler and preventDefaults the event.
 *  - A focused <input> suppresses every shortcut so the user can type
 *    "1" inside a rename field without flipping lighting mode.
 *  - TR keyboard layout: `event.code === "Digit1"` matches even when
 *    `event.key` becomes a punctuation symbol such as "±".
 *  - Unmount removes the keydown listener (no ghost handlers).
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGlobalKeybinds, type KeybindHandlers } from "../useGlobalKeybinds";
import { KEYBIND_ACTIONS } from "../../../shared/contracts/shell";

function dispatchKey(
  init: Partial<KeyboardEventInit> & { code: string; key?: string },
  target?: Element,
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  });
  (target ?? document).dispatchEvent(event);
  return event;
}

describe("useGlobalKeybinds — platform-aware shortcut routing", () => {
  let handlers: KeybindHandlers;
  let modeOff: ReturnType<typeof vi.fn<() => void>>;
  let modeAmbilight: ReturnType<typeof vi.fn<() => void>>;
  let openSettings: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    modeOff = vi.fn<() => void>();
    modeAmbilight = vi.fn<() => void>();
    openSettings = vi.fn<() => void>();
    handlers = {
      [KEYBIND_ACTIONS.MODE_OFF]: modeOff,
      [KEYBIND_ACTIONS.MODE_AMBILIGHT]: modeAmbilight,
      [KEYBIND_ACTIONS.OPEN_SETTINGS]: openSettings,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes Alt+Digit1 to MODE_OFF handler on the default platform", () => {
    renderHook(() => useGlobalKeybinds(handlers, { platform: "default" }));

    act(() => {
      const event = dispatchKey({ code: "Digit1", key: "1", altKey: true });
      expect(event.defaultPrevented).toBe(true);
    });

    expect(modeOff).toHaveBeenCalledTimes(1);
    expect(modeAmbilight).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("suppresses every shortcut while an <input> holds focus", () => {
    renderHook(() => useGlobalKeybinds(handlers, { platform: "default" }));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    try {
      act(() => {
        // Dispatching on the input bubbles to document, but isEditableTarget
        // must short-circuit before invoking the handler.
        dispatchKey({ code: "Digit1", key: "1", altKey: true }, input);
      });

      expect(modeOff).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it("matches Digit1 even when event.key is a TR-layout symbol", () => {
    renderHook(() => useGlobalKeybinds(handlers, { platform: "default" }));

    act(() => {
      // On TR keyboards Alt+1 produces event.key === "±" / "¡" etc., but
      // event.code stays Digit1 — the hook MUST key off .code to survive.
      dispatchKey({ code: "Digit1", key: "±", altKey: true });
    });

    expect(modeOff).toHaveBeenCalledTimes(1);
  });

  it("removes the document keydown listener on unmount", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() =>
      useGlobalKeybinds(handlers, { platform: "default" }),
    );

    const addedKeydown = addSpy.mock.calls.some(([type]) => type === "keydown");
    expect(addedKeydown).toBe(true);

    unmount();

    const removedKeydown = removeSpy.mock.calls.some(([type]) => type === "keydown");
    expect(removedKeydown).toBe(true);

    // Post-unmount dispatch must not fire any handler.
    dispatchKey({ code: "Digit1", key: "1", altKey: true });
    expect(modeOff).not.toHaveBeenCalled();
  });

  it("ignores keys whose required modifier is absent", () => {
    renderHook(() => useGlobalKeybinds(handlers, { platform: "default" }));

    act(() => {
      // Plain Digit1 without Alt must NOT fire MODE_OFF.
      dispatchKey({ code: "Digit1", key: "1" });
    });

    expect(modeOff).not.toHaveBeenCalled();
  });
});
