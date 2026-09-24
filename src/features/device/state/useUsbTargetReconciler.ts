import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { normalizeOutputTargets } from "@/shared/contracts/mode";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { connectionEvents } from "../connectionEvents";

/** How long either USB-unplugged toast stays up. */
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
  /** A saved output choice, as if the user made it: pairing a strip, the unsupported-port fallback. */
  onSelectTargets: (targets: HueRuntimeTarget[]) => Promise<void>;
  /** Session-only: an unplug never rewrites `lastOutputTargets`. */
  onDropUsbTarget: (targets: HueRuntimeTarget[]) => Promise<void>;
  /** The same, when USB was the only selected target. Resolves whether a running mode ended. */
  onLastTargetUnplugged: () => Promise<boolean>;
}

export interface UsbTargetReconciler {
  /** Unplugged; the other selected targets carry on. */
  usbDisconnectNotice: boolean;
  /** Unplugged while it was the only target, so the running mode ended. */
  usbDisconnectLightingOffNotice: boolean;
  usbUnsupportedNotice: boolean;
  /** Which fallback the unsupported notice reports: Hue took over, or nothing is selected. */
  usbUnsupportedHueFallback: boolean;
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
  onSelectTargets,
  onDropUsbTarget,
  onLastTargetUnplugged,
}: UsbTargetReconcilerInput): UsbTargetReconciler {
  // Hot-plug detection ref — null until bootstrap arms it.
  const prevUsbConnectedRef = useRef<boolean | null>(null);
  const [usbDisconnectNotice, setUsbDisconnectNotice] = useState<"continuing" | "lightingOff" | null>(null);
  // Bug 10D — surfaces a one-time non-blocking notice when boot-time
  // auto-reconnect rejects with PORT_UNSUPPORTED / PORT_NOT_FOUND, so
  // the user understands why we just dropped them into Hue-only mode.
  const [usbUnsupportedNotice, setUsbUnsupportedNotice] = useState(false);
  const [usbUnsupportedHueFallback, setUsbUnsupportedHueFallback] = useState(true);

  const armUsbConnected = useCallback((connected: boolean) => {
    prevUsbConnectedRef.current = connected;
  }, []);

  // Hot-plug detection. Gated on `bootstrapDone` because `prevUsbConnectedRef`
  // is meaningless until bootstrap has armed it.
  useEffect(() => {
    if (!bootstrapDone) return; // Skip until bootstrap sets ref and flag

    const wasConnected = prevUsbConnectedRef.current;

    if (wasConnected === false && isConnected) {
      // Pairing is itself the "I want USB output" intent: it is saved, and a
      // running mode starts on the strip. See docs/architecture/ui-and-shell.md.
      if (!selectedOutputTargets.includes("usb")) {
        void onSelectTargets(normalizeOutputTargets([...selectedOutputTargets, "usb"]));
      }
    }

    if (wasConnected === true && !isConnected) {
      // USB just unplugged: drop it from the targets for this session.
      if (selectedOutputTargets.includes("usb")) {
        const nextTargets = selectedOutputTargets.filter((t) => t !== "usb");
        if (nextTargets.length > 0) {
          void onDropUsbTarget(nextTargets);
          setUsbDisconnectNotice("continuing");
        } else {
          // Nothing else to run on, so a running mode ends and the selection
          // stays, as Off leaves it. Told only once it has: with the mode
          // already off, or a stop that failed, there is nothing to report.
          void onLastTargetUnplugged()
            .then((ended) => {
              if (ended) setUsbDisconnectNotice("lightingOff");
            })
            .catch((err) => {
              console.error("[LumaSync] Ending the lighting mode after the USB unplug failed:", err);
            });
        }
      }
    }

    prevUsbConnectedRef.current = isConnected;
  }, [isConnected, selectedOutputTargets, onSelectTargets, onDropUsbTarget, onLastTargetUnplugged, bootstrapDone]);

  // Own effect keyed on the flag it clears — the hot-plug effect above re-runs
  // whenever `selectedOutputTargets` changes, which its own unplug branch causes.
  // See docs/architecture/ui-and-shell.md.
  useEffect(() => {
    if (!usbDisconnectNotice) return;
    const timerId = window.setTimeout(() => setUsbDisconnectNotice(null), USB_DISCONNECT_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [usbDisconnectNotice]);

  // Bug 10D — drop "usb" when auto-reconnect reports the port structurally
  // unavailable, or every later mode change dies silently in the Rust gate. Why
  // only those codes: ui-and-shell.md.
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
      void onSelectTargets(nextTargets);
      // "Switched to Hue" is only true when Hue is what is left.
      setUsbUnsupportedHueFallback(nextTargets.includes("hue"));
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
  }, [selectedOutputTargetsRef, hueStartConfigRef, onSelectTargets]);

  return {
    usbDisconnectNotice: usbDisconnectNotice === "continuing",
    usbDisconnectLightingOffNotice: usbDisconnectNotice === "lightingOff",
    usbUnsupportedNotice,
    usbUnsupportedHueFallback,
    armUsbConnected,
  };
}
