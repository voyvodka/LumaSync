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

  // ---------------------------------------------------------------------------
  // Hot-plug detection: USB plug/unplug target management (D-07, D-08)
  // Guard: only runs after bootstrap has initialized prevUsbConnectedRef
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Bug 10D — boot-time USB unsupported / missing fallback
  //
  // After commit 72fba5b ("reject non-USB serial ports up-front") the
  // backend rejects previously-accepted phantom ports (e.g.
  // /dev/cu.Bluetooth-Incoming-Port on macOS). Auto-reconnect on init
  // emits the rejection code via `connectionEvents`, but `selectedOutputTargets`
  // still includes "usb", so every subsequent `set_lighting_mode` invoke
  // hits the Rust USB gate and returns `DEVICE_NOT_CONNECTED` silently.
  // From the user's seat, "Ambilight does nothing".
  //
  // Fix: subscribe to the bus once, drop "usb" from targets on the
  // PORT_UNSUPPORTED / PORT_NOT_FOUND signal, persist via the existing
  // shellStore facade, and surface a one-time toast. We deliberately do
  // NOT call `handleOutputTargetsChange` (its delta-stop branch tries to
  // invoke `stop_lighting`, which is meaningless when nothing is running
  // — boot path is always at OFF until the user picks a mode).
  // ---------------------------------------------------------------------------
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
      // If the user has a paired Hue bridge and hue is not already in the
      // surviving targets, auto-add "hue" so Ambilight / Solid actually
      // produces output instead of leaving the user stranded at the OFF
      // state with no available sink. This also covers the case where a
      // prior session already auto-deselected USB and persisted `[]` —
      // boot lands here with `currentTargets === []`, no USB to drop, but
      // Hue must still get auto-added or the user has zero output sinks
      // and "ambilight does nothing" silently repeats.
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
