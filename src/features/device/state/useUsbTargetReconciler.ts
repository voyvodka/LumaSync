import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { normalizeOutputTargets } from "@/features/mode/model/contracts";
import { saveShellState } from "@/features/shell/windowLifecycle";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { connectionEvents } from "../connectionEvents";

/** How long the "USB unplugged, continuing with remaining targets" toast stays up. */
const USB_DISCONNECT_NOTICE_MS = 5_000;
/** The boot-time unsupported-port toast carries more to read, so it stays up longer. */
const USB_UNSUPPORTED_NOTICE_MS = 6_000;

export interface UsbTargetReconcilerInput {
  isConnected: boolean;
  bootstrapDone: boolean;
  selectedOutputTargets: HueRuntimeTarget[];
  /** Read by the `[]`-dep connection-event subscriber, which must not re-subscribe. */
  selectedOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  hueStartConfigRef: RefObject<unknown>;
  /** Direct target write — deliberately NOT the general target-change handler. */
  onAutoAddUsbTarget: (targets: HueRuntimeTarget[]) => void;
  /** Full target-change handler, so the unplug runs the delta-stop pipeline. */
  onDropUsbTarget: (targets: HueRuntimeTarget[]) => void;
  onFallbackTargets: (targets: HueRuntimeTarget[]) => void;
}

export interface UsbTargetReconciler {
  usbDisconnectNotice: boolean;
  usbUnsupportedNotice: boolean;
  /** Bootstrap arms the edge detector from the live USB snapshot. */
  armUsbConnected: (connected: boolean) => void;
}

/**
 * Reconciles `selectedOutputTargets` against the two USB signals that arrive
 * outside the user's control: a runtime hot-plug edge, and the boot-time
 * unsupported/missing-port rejection.
 */
export function useUsbTargetReconciler({
  isConnected,
  bootstrapDone,
  selectedOutputTargets,
  selectedOutputTargetsRef,
  hueStartConfigRef,
  onAutoAddUsbTarget,
  onDropUsbTarget,
  onFallbackTargets,
}: UsbTargetReconcilerInput): UsbTargetReconciler {
  // Hot-plug detection ref — null until bootstrap arms it.
  const prevUsbConnectedRef = useRef<boolean | null>(null);
  const [usbDisconnectNotice, setUsbDisconnectNotice] = useState(false);
  // Bug 10D — surfaces a one-time non-blocking notice when boot-time
  // auto-reconnect rejects with PORT_UNSUPPORTED / PORT_NOT_FOUND, so
  // the user understands why we just dropped them into Hue-only mode.
  const [usbUnsupportedNotice, setUsbUnsupportedNotice] = useState(false);

  const armUsbConnected = useCallback((connected: boolean) => {
    prevUsbConnectedRef.current = connected;
  }, []);

  // Hot-plug detection. Gated on `bootstrapDone` because `prevUsbConnectedRef`
  // is meaningless until bootstrap has armed it.
  useEffect(() => {
    if (!bootstrapDone) return; // Skip until bootstrap sets ref and flag

    const wasConnected = prevUsbConnectedRef.current;

    if (wasConnected === false && isConnected) {
      // Pairing is itself the "I want USB output" intent, and the target is
      // added directly rather than through `handleOutputTargetsChange`.
      // Both halves are load-bearing — docs/architecture/ui-and-shell.md.
      if (!selectedOutputTargets.includes("usb")) {
        const nextTargets = normalizeOutputTargets([...selectedOutputTargets, "usb"]);
        onAutoAddUsbTarget(nextTargets);
        void saveShellState({ lastOutputTargets: nextTargets }).catch((err) => {
          console.error("[LumaSync] saveShellState(lastOutputTargets) on auto-add failed:", err);
        });
      }
    }

    if (wasConnected === true && !isConnected) {
      // USB just unplugged (D-08) — silently drop from targets
      if (selectedOutputTargets.includes("usb")) {
        const nextTargets = selectedOutputTargets.filter((t) => t !== "usb");
        if (nextTargets.length > 0) {
          onDropUsbTarget(nextTargets);
          setUsbDisconnectNotice(true);
        }
        // If no targets remain, keep current targets — mode buttons will show disabled via guard
      }
    }

    prevUsbConnectedRef.current = isConnected;
  }, [isConnected, selectedOutputTargets, onAutoAddUsbTarget, onDropUsbTarget, bootstrapDone]);

  // Own effect keyed on the flag it clears — the hot-plug effect above re-runs
  // whenever `selectedOutputTargets` changes, which its own unplug branch causes.
  // See docs/architecture/ui-and-shell.md.
  useEffect(() => {
    if (!usbDisconnectNotice) return;
    const timerId = window.setTimeout(() => setUsbDisconnectNotice(false), USB_DISCONNECT_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [usbDisconnectNotice]);

  // Bug 10D — drop "usb" when auto-reconnect reports the port structurally
  // unavailable, or every later mode change dies silently in the Rust gate. Why
  // only those codes, and not via `handleOutputTargetsChange`: ui-and-shell.md.
  useEffect(() => {
    let unsupportedNoticeTimerId: number | null = null;
    const unsubscribe = connectionEvents.subscribe((event) => {
      if (event.connected || !event.unsupportedReason) return;
      const currentTargets = selectedOutputTargetsRef.current;
      const includedUsb = currentTargets.includes("usb");
      // Use the raw filter result. `normalizeOutputTargets([])` reverts to
      // DEFAULT_OUTPUT_TARGETS (= ["usb"]) which would silently re-add the
      // very target we are trying to drop, defeating the fallback.
      const filtered = currentTargets.filter((t) => t !== "usb") as HueRuntimeTarget[];
      // Auto-add Hue so the user is not left with zero sinks. This also has to
      // fire when a prior session already persisted `[]` — there is no USB left
      // to drop, but without Hue the silent no-output state simply repeats.
      const huePaired = hueStartConfigRef.current !== null;
      const wantsHueAutoAdd = huePaired && !filtered.includes("hue");
      // If we have nothing to do (USB not in targets and no hue auto-add
      // needed) skip without persisting / toasting.
      if (!includedUsb && !wantsHueAutoAdd) return;
      const nextTargets: HueRuntimeTarget[] = wantsHueAutoAdd ? ["hue"] : filtered;
      onFallbackTargets(nextTargets);
      void saveShellState({ lastOutputTargets: nextTargets }).catch((err) => {
        console.error(
          "[LumaSync] saveShellState(lastOutputTargets) on unsupported-port fallback failed:",
          err,
        );
      });
      setUsbUnsupportedNotice(true);
      unsupportedNoticeTimerId = window.setTimeout(
        () => setUsbUnsupportedNotice(false),
        USB_UNSUPPORTED_NOTICE_MS,
      );
    });
    return () => {
      unsubscribe();
      if (unsupportedNoticeTimerId !== null) {
        window.clearTimeout(unsupportedNoticeTimerId);
        unsupportedNoticeTimerId = null;
      }
    };
  }, [selectedOutputTargetsRef, hueStartConfigRef, onFallbackTargets]);

  return { usbDisconnectNotice, usbUnsupportedNotice, armUsbConnected };
}
