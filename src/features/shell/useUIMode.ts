// useUIMode — compact/full layout mode hook. Sequential transition
// (fade out → resize → mount + fade in), deliberately not a cross-fade —
// see docs/architecture/ui-and-shell.md. A call during a transition joins it.

import { useState, useCallback, useRef } from "react";
import type { UIMode } from "@/shared/contracts/shell";
import { resizeToMode } from "./windowLifecycle";
import { waitForFrames } from "./frameWait";

/** Fade-out / fade-in duration. Kept short so total transition feels snappy. */
export const UI_MODE_FADE_DURATION_MS = 160;
/**
 * Easing applied to both the CSS opacity fade and the window resize. Matches
 * `easeOutCubic` used by `animateWindowRect` so the two halves of the
 * transition feel like one continuous motion.
 */
export const UI_MODE_FADE_TIMING = "cubic-bezier(0.33, 1, 0.68, 1)";
/** Safety net: never hang the chain if `transitionend` misfires. */
const FADE_SAFETY_TIMEOUT_MS = UI_MODE_FADE_DURATION_MS + 120;

function waitForOpacityTransition(el: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", onEnd);
      resolve();
    };

    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el) return;
      if (event.propertyName !== "opacity") return;
      finish();
    };

    el.addEventListener("transitionend", onEnd);
    setTimeout(finish, FADE_SAFETY_TIMEOUT_MS);
  });
}

export function useUIMode() {
  const [currentMode, setCurrentMode] = useState<UIMode>("compact");
  const [isContentVisible, setIsContentVisible] = useState(true);
  const [isUITransitioning, setIsUITransitioning] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const currentModeRef = useRef(currentMode);
  currentModeRef.current = currentMode;

  // The one owner of the window's compact/full size: every caller comes through
  // here, and a caller arriving mid-transition awaits the running one instead of
  // starting a second resize animation against it.
  const switchUIMode = useCallback((nextMode: UIMode): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    if (nextMode === currentModeRef.current) return Promise.resolve();

    const run = (async () => {
      setIsUITransitioning(true);
      try {
        // Phase 1: fade the current layout out. Backdrop stays visible.
        setIsContentVisible(false);
        await waitForOpacityTransition(contentRef.current);

        // Phase 2: resize the Tauri window while the backdrop is the only
        // thing visible, so reflow of either layout is invisible to the user.
        await resizeToMode(nextMode);

        // Phase 3: swap the mode so the new layout mounts at the final
        // window size, wait one paint cycle to ensure it renders at
        // opacity 0, then trigger the fade-in.
        currentModeRef.current = nextMode;
        setCurrentMode(nextMode);
        await waitForFrames(2);
        setIsContentVisible(true);
        await waitForOpacityTransition(contentRef.current);
      } catch (err) {
        console.error("[LumaSync] switchUIMode failed:", err);
      } finally {
        // Idempotent on success. On a failed resize the old layout fades back
        // in rather than staying at opacity 0 with pointer events off.
        setIsContentVisible(true);
        setIsUITransitioning(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
  }, []);

  return {
    currentMode,
    isContentVisible,
    isUITransitioning,
    contentRef,
    switchUIMode,
    setCurrentMode,
  } as const;
}
