/**
 * useUIMode — UI layout mode hook (compact / full).
 *
 * Manages the active UIMode and orchestrates a cross-fade transition between
 * modes. The hook keeps two mode slots:
 *
 *   - `currentMode`  — the layout currently mounted as the "outgoing" slot.
 *   - `incomingMode` — the layout being faded IN (null when not transitioning).
 *
 * During a switch, both slots are rendered simultaneously inside a stable
 * container. Their dimensions are **pinned** to the from/to logical pixel
 * sizes for the duration of the transition. This prevents layout reflow as
 * the window itself animates its size — without pinning, every `setSize`
 * frame would change `100vh`, causing the layout to visibly wobble as flex
 * items redistribute.
 *
 * Re-entrancy: a second `switchUIMode` call while a transition is still
 * running is ignored.
 */

import { useState, useCallback, useRef } from "react";
import type { UIMode } from "../../shared/contracts/shell";
import {
  getCurrentLogicalSize,
  getTargetModeSize,
  resizeToMode,
} from "./windowLifecycle";

/** Must match the Tailwind `duration-200` on the cross-fade slots. */
const FADE_DURATION_MS = 200;
/** Safety net: never hang the chain if `transitionend` misfires. */
const FADE_SAFETY_TIMEOUT_MS = FADE_DURATION_MS + 100;

export interface SlotSize {
  width: number;
  height: number;
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
  const [incomingMode, setIncomingMode] = useState<UIMode | null>(null);
  const [isIncomingVisible, setIsIncomingVisible] = useState(false);
  const [outgoingSize, setOutgoingSize] = useState<SlotSize | null>(null);
  const [incomingSize, setIncomingSize] = useState<SlotSize | null>(null);
  const incomingRef = useRef<HTMLDivElement>(null);

  const isUITransitioning = incomingMode !== null;

  const switchUIMode = useCallback(
    async (nextMode: UIMode) => {
      if (nextMode === currentMode) return;
      if (incomingMode !== null) return; // re-entrancy guard

      // Capture from/to logical sizes BEFORE any state update. The outgoing
      // slot will be pinned to its current on-screen size so committing the
      // pinned width/height is a no-op visually.
      const fromSize = await getCurrentLogicalSize();
      const toSize = await getTargetModeSize(nextMode);

      // 1. Pin slot sizes and mount the incoming slot at opacity 0.
      setOutgoingSize(fromSize);
      setIncomingSize(toSize);
      setIncomingMode(nextMode);
      setIsIncomingVisible(false);
      // Double rAF so the browser commits the initial pinned styles and
      // opacity-0 state before we flip to the visible state that triggers
      // the CSS transition.
      await nextDoublePaint();

      // 2. Trigger the cross-fade and animated window resize in parallel.
      //    Neither slot reflows during the window animation because their
      //    logical dimensions are pinned via inline style.
      setIsIncomingVisible(true);
      const fadePromise = waitForOpacityTransition(incomingRef.current);
      const resizePromise = resizeToMode(nextMode);
      await Promise.all([fadePromise, resizePromise]);

      // 3. Promote incoming → current, unmount the outgoing slot, and drop
      //    the pinned sizes so the layout once again fills the window via
      //    100% parent-relative dimensions.
      setCurrentMode(nextMode);
      setIncomingMode(null);
      setIsIncomingVisible(false);
      setOutgoingSize(null);
      setIncomingSize(null);
    },
    [currentMode, incomingMode],
  );

  return {
    currentMode,
    incomingMode,
    isIncomingVisible,
    isUITransitioning,
    outgoingSize,
    incomingSize,
    incomingRef,
    switchUIMode,
    setCurrentMode,
  } as const;
}
