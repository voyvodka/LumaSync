/**
 * useUIMode — UI layout mode hook (compact / full).
 *
 * Orchestrates a fully sequential transition between layout modes to eliminate
 * the progressive-clipping artifact that a parallel cross-fade produces when
 * the incoming slot is pinned at its target size while the window is still
 * animating toward that size.
 *
 * Transition phases (single slot, no pinning):
 *   1. Fade the current content out (opacity 1 → 0).
 *   2. Animate the Tauri window to the target mode size. The backdrop is the
 *      only thing visible during this step, so reflow of either layout is
 *      invisible to the user.
 *   3. Swap `currentMode` so the incoming layout mounts at the final size,
 *      wait one paint, then fade it back in (opacity 0 → 1).
 *
 * Re-entrancy: a second `switchUIMode` call while a transition is still
 * running is ignored.
 */

import { useState, useCallback, useRef } from "react";
import type { UIMode } from "../../shared/contracts/shell";
import { resizeToMode } from "./windowLifecycle";

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

/**
 * LED edge sweep overlay: each bar animates for 420 ms, staggered by 50 ms
 * per edge (top 0 ms → right 50 ms → bottom 100 ms → left 150 ms).
 * Total wall-clock duration until the last bar finishes: 420 + 150 = 570 ms.
 * The window resize (~220 ms) completes well before the sweep ends — both
 * run in parallel so the resize settles while the sweep is still travelling.
 */
export const UI_MODE_SWEEP_DURATION_MS = 420;
const SWEEP_TOTAL_MS = UI_MODE_SWEEP_DURATION_MS + 150; // 570 ms total

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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

function nextDoublePaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export function useUIMode() {
  const [currentMode, setCurrentMode] = useState<UIMode>("compact");
  const [isContentVisible, setIsContentVisible] = useState(true);
  const [isUITransitioning, setIsUITransitioning] = useState(false);
  const [isSweepActive, setIsSweepActive] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const transitionLockRef = useRef(false);

  const switchUIMode = useCallback(
    async (nextMode: UIMode) => {
      if (nextMode === currentMode) return;
      if (transitionLockRef.current) return; // re-entrancy guard
      transitionLockRef.current = true;
      setIsUITransitioning(true);

      const reducedMotion = prefersReducedMotion();

      try {
        // Phase 1: fade the current layout out. Backdrop stays visible.
        setIsContentVisible(false);
        await waitForOpacityTransition(contentRef.current);

        // Phase 2: arm the LED edge sweep overlay (skipped under
        // prefers-reduced-motion) and start the window resize in parallel.
        // Resize completes in ~220 ms; sweep total is 570 ms (420 ms bar
        // duration + 150 ms stagger across 4 edges). The two run together so
        // the resize finishes while the sweep is still travelling — the effect
        // reads as a single signal wrapping around the frame as the chrome
        // settles into its new size.
        if (reducedMotion) {
          await resizeToMode(nextMode);
        } else {
          setIsSweepActive(true);
          const sweepTimer = new Promise<void>((resolve) => setTimeout(resolve, SWEEP_TOTAL_MS));
          await Promise.all([resizeToMode(nextMode), sweepTimer]);
          setIsSweepActive(false);
        }

        // Phase 3: swap the mode so the new layout mounts at the final
        // window size, wait one paint cycle to ensure it renders at
        // opacity 0, then trigger the fade-in.
        setCurrentMode(nextMode);
        await nextDoublePaint();
        setIsContentVisible(true);
        await waitForOpacityTransition(contentRef.current);
      } finally {
        setIsUITransitioning(false);
        transitionLockRef.current = false;
      }
    },
    [currentMode],
  );

  return {
    currentMode,
    isContentVisible,
    isUITransitioning,
    isSweepActive,
    contentRef,
    switchUIMode,
    setCurrentMode,
  } as const;
}
