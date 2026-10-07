// useUIMode — compact/full layout mode hook. Sequential transition
// (fade out → resize → mount + fade in), deliberately not a cross-fade —
// see docs/architecture/ui-and-shell.md. A call during a transition joins it.
// The interface size changes through the same three phases.

import { useState, useCallback, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UIMode, UiZoom } from "@/shared/contracts/shell";
import { framedUiZoom, resizeToMode, windowLifecycleSettled } from "./windowLifecycle";
import { waitForFrames } from "./frameWait";
import { applyChromeScale } from "./useUiZoom";

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
    if (inFlightRef.current !== null) return inFlightRef.current;
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

  // Settings → Interface size. The webview's zoom reflows the whole page at once, so it is applied
  // while only the backdrop shows, together with the title bar's counter-scale and the frame's
  // refit. A size chosen while a run is going is taken by that run's next pass.
  const pendingZoomRef = useRef<UiZoom | null>(null);
  const zoomRunRef = useRef<Promise<void> | null>(null);
  const applyUiZoom = useCallback((zoom: UiZoom): Promise<void> => {
    pendingZoomRef.current = zoom;
    if (zoomRunRef.current !== null) return zoomRunRef.current;

    const rezoom = async (target: UiZoom) => {
      await windowLifecycleSettled();
      const from = framedUiZoom();
      // The boot read already zoomed and framed the window; hydration arriving after it is not a change.
      if (target / 100 === from) {
        applyChromeScale(target);
        return;
      }
      setIsUITransitioning(true);
      try {
        setIsContentVisible(false);
        await waitForOpacityTransition(contentRef.current);
        // Sizes chosen during the fade (⌘+ held) land in this one pass, the latest of them.
        const size = pendingZoomRef.current ?? target;
        pendingZoomRef.current = null;
        await getCurrentWebview().setZoom(size / 100);
        applyChromeScale(size);
        await resizeToMode(currentModeRef.current, { zoom: size / 100, fromZoom: from });
        await waitForFrames(2);
        setIsContentVisible(true);
        await waitForOpacityTransition(contentRef.current);
      } catch (err) {
        console.error("[LumaSync] changing the interface size failed:", err);
      } finally {
        setIsContentVisible(true);
        setIsUITransitioning(false);
      }
    };

    const run = (async () => {
      try {
        while (pendingZoomRef.current !== null) {
          // A mode switch in flight sizes the frame first; it read the zoom it framed for.
          while (inFlightRef.current !== null) await inFlightRef.current;
          const target = pendingZoomRef.current;
          pendingZoomRef.current = null;
          const pass = rezoom(target);
          // A mode switch asked for mid-pass joins it, as it would join another mode switch.
          inFlightRef.current = pass;
          try {
            await pass;
          } finally {
            inFlightRef.current = null;
          }
        }
      } finally {
        zoomRunRef.current = null;
      }
    })();
    zoomRunRef.current = run;
    return run;
  }, []);

  return {
    currentMode,
    isContentVisible,
    isUITransitioning,
    contentRef,
    switchUIMode,
    applyUiZoom,
    setCurrentMode,
  } as const;
}
