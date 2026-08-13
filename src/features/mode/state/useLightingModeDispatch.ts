import { useCallback, useRef, type RefObject } from "react";

import { setLightingMode } from "../modeApi";
import type { LightingModeConfig } from "../model/contracts";
import { canonicalLightingModeSignature } from "./modePayloadHydration";

/**
 * Hard floor on the rate at which non-`force` `setLightingMode` invokes are
 * allowed to reach the Tauri backend. Belt-and-braces backstop for the
 * content-based dedup signature: even if a re-render storm somehow produces
 * payloads whose canonical hash differs, the cooldown swallows everything
 * within 20 ms of the previous dispatch. This caps the FE→Rust hot path at
 * 50 Hz, which is well above any legitimate quick-adjustment source — the
 * HsvColorPicker drag throttle commits at 50 ms (20 Hz) and CompactLayout's
 * brightness slider at 50 ms (20 Hz), so legit user actions never get
 * dropped by this floor.
 */
const SET_LIGHTING_MODE_MIN_INTERVAL_MS = 20;

export type LightingModeDispatcher = (
  mode: LightingModeConfig,
  opts?: { force?: boolean },
) => Promise<void>;

export interface LightingModeDispatch {
  dispatch: LightingModeDispatcher;
  /** Clears the dedup signature so the next dispatch always reaches the backend. */
  resetSignature: () => void;
  /** Public on purpose: lets a poll re-apply the mode without taking `dispatch` as a dep. */
  dispatchRef: RefObject<LightingModeDispatcher | null>;
}

/**
 * Idempotent funnel for every `setLightingMode` Tauri invoke (v1.5
 * fix #45 + Ambilight-spam follow-up).
 *
 * Every direct call site — quick adjustments, hot-reload effects
 * (color correction / firmware profile / lighting smoothing preset),
 * delta-start re-applies in `handleOutputTargetsChange`, slow-path
 * mode transitions — funnels through this helper so a stuck
 * subscriber, re-render storm, or React-19-StrictMode double-fire can
 * never spam the IPC bus with identical payloads. The Rust backend is
 * itself idempotent for matching kinds, but skipping the round-trip
 * keeps the worker fast-path uncluttered and the dev terminal
 * readable.
 *
 * `force: true` is reserved for paths where the backend may need a
 * forced re-apply even when the FE signature matches — e.g. the
 * delta-start re-apply after `startHue` succeeds (worker has to pick
 * up the now-live Hue context) and the slow-path mode-kind
 * transition (the prior signature is stale by definition). Force
 * always **updates** the ref so a subsequent identical fire from a
 * hot-reload effect is still skipped.
 */
export function useLightingModeDispatch(
  hydrate: (mode: LightingModeConfig) => LightingModeConfig,
): LightingModeDispatch {
  const lastSentPayloadSignatureRef = useRef<string | null>(null);
  const lastSetLightingModeAtRef = useRef<number>(0);
  const dispatchRef = useRef<LightingModeDispatcher | null>(null);

  const dispatch = useCallback<LightingModeDispatcher>(
    async (mode, opts = {}) => {
      const hydrated = hydrate(mode);
      // Content-based signature: order-independent key sort eliminates the
      // false-negative dedup that happened when `hydrateModePayload`'s
      // spread chain produced a different key insertion order across
      // back-to-back identical fires (Ambilight-mode spam regression — the
      // hot-reload paths in particular re-stamp `colorCorrection` /
      // `firmwareProfile` last, which moves them to the end of the object
      // every other call). See `canonicalLightingModeSignature` for the
      // full rationale.
      const signature = canonicalLightingModeSignature(hydrated);
      if (!opts.force) {
        // Layer 1 — content dedup. Identical semantic payload? Skip.
        if (lastSentPayloadSignatureRef.current === signature) {
          return;
        }
        // Layer 2 — temporal cooldown. Belt-and-braces for any unknown
        // 50–60 Hz spam source we have not traced yet (re-render storm,
        // stuck subscriber, future regression). The Rust handler is
        // idempotent for ambilight settings updates but takes the full
        // worker tear-down + restart path whenever any of its own
        // equality gates fail (targets / displayId / led_calibration /
        // color_correction / firmware_profile), so even a few stray
        // mismatches per second visibly stutter the strip. Capping the
        // dispatch rate at 50 Hz protects the worker without slowing
        // legitimate quick adjustments — drag commits across the app are
        // already throttled to 20 Hz upstream.
        const now = Date.now();
        if (now - lastSetLightingModeAtRef.current < SET_LIGHTING_MODE_MIN_INTERVAL_MS) {
          return;
        }
        lastSetLightingModeAtRef.current = now;
      } else {
        // `force` path still updates the cooldown clock so a follow-up
        // non-force fire 1 ms later is correctly cooled. Without this the
        // very next quick adjustment after a slow-path transition could
        // sneak through during the cooldown window.
        lastSetLightingModeAtRef.current = Date.now();
      }
      lastSentPayloadSignatureRef.current = signature;
      await setLightingMode(hydrated);
    },
    [hydrate],
  );

  // Assigned during render, not in an effect: a reconciler tick landing
  // between render and effect flush must still see a live dispatcher.
  dispatchRef.current = dispatch;

  const resetSignature = useCallback(() => {
    lastSentPayloadSignatureRef.current = null;
  }, []);

  return { dispatch, resetSignature, dispatchRef };
}
