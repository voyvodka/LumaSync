// Not in src/shared/contracts/: its mirror deliberately keeps fields optional
// that Rust always sends, which the contract verifier's nullability rule would
// reject — see the interface comment.
import type { DisplayId } from "@/shared/contracts/display";
import type { LedTestPatternKind } from "@/shared/contracts/preview";

/** Tauri event channel carrying the per-LED feed of the LED twin overlay. */
export const EDGE_SIGNAL_EVENT = "ambilight://edge-signal";

/** Per-LED frame the Rust ambilight worker sends to open twin-overlay windows.
 *
 * Sent only while a twin overlay is open, and only to twin windows — the main
 * window receives nothing. The worker sets `leds`, `ledCount`, `source` and
 * `seq` on every frame; they stay optional here so the twin keeps ignoring a
 * frame without a `leds` buffer rather than trusting the wire. */
export interface EdgeSignalPayload {
  /**
   * v1.6 — full per-LED RGB buffer for the digital-twin overlay, ordered along
   * the calibrated strip path.
   */
  leds?: Array<[number, number, number]>;
  /** v1.6 — length of `leds` (the calibrated total LED count for this frame). */
  ledCount?: number;
  /**
   * v1.6 — per-Hue-channel RGB the twin overlay renders for the Hue zone
   * markers. Kept separate from `leds` because Hue channels are sparse
   * positions in the room, not contiguous strip pixels.
   */
  hueChannels?: Array<[number, number, number]>;
  /** v1.6 — whether this frame originates from a synthetic test pattern or live capture. */
  source?: "test" | "live";
  /** v1.6 — active synthetic pattern kind when `source === "test"`. */
  pattern?: LedTestPatternKind;
  /** v1.6 — monotonically increasing frame sequence number for drop detection in the twin. */
  seq?: number;
  /** v1.6 — display the frame was sampled from, threaded through from the capture path. */
  displayId?: DisplayId;
}
