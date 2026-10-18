import type { KeyboardEvent } from "react";

const STEP_BY_KEY: Record<string, 1 | -1> = { ArrowRight: 1, ArrowLeft: -1 };

/**
 * A horizontal WAI-ARIA tablist with manual activation: the arrows, Home and End
 * move focus between the tabs and Enter or Space opens one, so an arrow never
 * opens a tab on the way past it. Attach to the tablist's `onKeyDown`.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  const step = STEP_BY_KEY[event.key];
  const next =
    step !== undefined
      ? tabs[(at + step + tabs.length) % tabs.length]
      : event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs[tabs.length - 1]
          : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}
