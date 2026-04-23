/**
 * useGlobalKeybinds — owns every global keyboard shortcut the shell
 * advertises in the status bar + mode strip.
 *
 * Before this hook existed the `⌥1/⌥2/⌥3/⌘,` badges were decorative only —
 * no keydown listener matched them, so the UI lied about what it could do.
 * Now every badge rendered from `KEYBIND_REGISTRY` is backed by a handler
 * here.
 *
 * ## Layout safety
 * Detection uses `event.code` (`Digit1` / `Digit2` / `Digit3` / `Comma`),
 * not `event.key`. On TR keyboards `Alt+1` produces `event.key === "¡"`
 * while `event.code` remains `Digit1`, so `event.code`-based matching is
 * layout-independent.
 *
 * ## Focus suppression
 * Editable fields (`<input>`, `<textarea>`, `contenteditable`) swallow the
 * shortcut. Without this guard `⌥1` while a rename input is focused would
 * flip the lighting mode mid-edit.
 *
 * ## Consumers
 * Wire this hook from `App.tsx` once — the handler map routes each
 * `KeybindAction` to the correct shell callback (mode dispatch, section
 * switch).
 */

import { useEffect, useRef } from "react";

import {
  KEYBIND_ACTIONS,
  type KeybindAction,
  type KeybindDefinition,
  type KeybindPlatform,
  getKeybindDefinition,
  resolveKeybindPlatform,
} from "../../shared/contracts/shell";

/**
 * Callback map — each action in `KEYBIND_ACTIONS` maps to a handler the
 * shell wires up (mode dispatch, section switch). An absent action is
 * treated as unbound and skipped.
 */
export type KeybindHandlers = Partial<Record<KeybindAction, () => void>>;

interface UseGlobalKeybindsOptions {
  /**
   * Platform override for deterministic tests. Production code should
   * leave this unset so `resolveKeybindPlatform()` inspects `navigator`.
   */
  platform?: KeybindPlatform;
  /**
   * Disable the hook entirely — used while a modal owns the keyboard or
   * during the UI-mode fade so shortcuts do not fire mid-transition.
   */
  disabled?: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

function modifierMatches(event: KeyboardEvent, definition: KeybindDefinition): boolean {
  switch (definition.modifier) {
    case "alt":
      // `altKey` covers macOS Option and Windows/Linux Alt. Reject combined
      // meta/ctrl so `Ctrl+Alt+1` (system-level shortcut on some distros)
      // does not double-fire.
      return event.altKey && !event.metaKey && !event.ctrlKey;
    case "meta":
      return event.metaKey && !event.altKey && !event.ctrlKey;
    case "ctrl":
      return event.ctrlKey && !event.altKey && !event.metaKey;
    default:
      return false;
  }
}

/**
 * Wire every entry in `handlers` to a matching platform-aware keybind.
 *
 * The listener is attached to `document` on mount and removed on unmount
 * (cleanup asserted in tests via `removeEventListener` spy).
 */
export function useGlobalKeybinds(
  handlers: KeybindHandlers,
  options: UseGlobalKeybindsOptions = {},
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const { platform, disabled = false } = options;

  useEffect(() => {
    if (disabled) return undefined;

    const resolvedPlatform = platform ?? resolveKeybindPlatform();
    const definitions: Array<[KeybindAction, KeybindDefinition]> = (
      Object.values(KEYBIND_ACTIONS) as KeybindAction[]
    ).map((action) => [action, getKeybindDefinition(action, resolvedPlatform)]);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      for (const [action, definition] of definitions) {
        if (event.code !== definition.code) continue;
        if (!modifierMatches(event, definition)) continue;
        const handler = handlersRef.current[action];
        if (!handler) continue;

        event.preventDefault();
        event.stopPropagation();
        handler();
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [disabled, platform]);
}
