/**
 * useLedPreviewFrame — subscribe to the enriched edge-signal stream.
 *
 * The ambilight worker emits `ambilight://edge-signal` at ~10 Hz, rising to
 * ~30 Hz while a twin is open so a moving pattern stays gap-free. When a
 * preview surface is subscribed, the worker enriches the payload ADDITIVELY
 * with the full per-LED buffer (`leds`), the calibrated `ledCount`, sparse
 * `hueChannels`, the frame `source`/`pattern`, a `seq` counter, and the
 * `displayId` the frame was sampled from (see
 * `features/mode/model/contracts.ts > EdgeSignalPayload`).
 *
 * The twin overlay window is bound to ONE display, so this hook filters by
 * `displayId`: a frame is accepted only when the caller did not request a
 * specific display, OR the frame carries no display id, OR the ids match.
 * Frames without a `leds` buffer (the legacy edge-only consumer path) are
 * ignored — they carry no per-LED data for the twin.
 */

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  EDGE_SIGNAL_EVENT,
  type EdgeSignalPayload,
} from "../../mode/model/contracts";
import type { LedTestPatternKind } from "../../../shared/contracts/preview";

export interface LedPreviewFrame {
  /** Full per-LED RGB buffer, ordered along the calibrated strip path. */
  leds: Array<[number, number, number]>;
  /** Calibrated total LED count for this frame. */
  ledCount: number;
  /** Sparse per-Hue-channel RGB for the twin's Hue zone markers. */
  hueChannels: Array<[number, number, number]>;
  /** Whether this frame is a synthetic test pattern or live capture. */
  source: "test" | "live" | null;
  /** Active synthetic pattern when `source === "test"`. */
  pattern: LedTestPatternKind | null;
  /** Monotonic frame sequence number (drop detection). */
  seq: number | null;
}

/**
 * @param displayId Restrict to frames sampled from this display. Absent ⇒
 *   accept every enriched frame regardless of display.
 */
export function useLedPreviewFrame(displayId?: string): LedPreviewFrame | null {
  const [frame, setFrame] = useState<LedPreviewFrame | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;

    listen<EdgeSignalPayload>(EDGE_SIGNAL_EVENT, (event) => {
      const payload = event.payload;
      // Filter by display only when both sides name one.
      if (displayId && payload.displayId && payload.displayId !== displayId) return;
      // Only the enriched preview path carries the per-LED buffer.
      if (!payload.leds) return;

      setFrame({
        leds: payload.leds,
        ledCount: payload.ledCount ?? payload.leds.length,
        hueChannels: payload.hueChannels ?? [],
        source: payload.source ?? null,
        pattern: payload.pattern ?? null,
        seq: payload.seq ?? null,
      });
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] useLedPreviewFrame listen failed:", error);
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [displayId]);

  return frame;
}
