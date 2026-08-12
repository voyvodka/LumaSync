/** Tauri command ids for display enumeration and the calibration overlay window. */
export const DISPLAY_OVERLAY_COMMANDS = {
  LIST_DISPLAYS: "list_displays",
  OPEN_DISPLAY_OVERLAY: "open_display_overlay",
  CLOSE_DISPLAY_OVERLAY: "close_display_overlay",
  UPDATE_DISPLAY_OVERLAY_PREVIEW: "update_display_overlay_preview",
} as const;

/** Opaque identifier for a physical display, as reported by the OS. */
export type DisplayId = string;

/** One edge of the LED strip layout around a display. */
export type OverlaySegment = "top" | "right" | "bottom" | "left";

/** LED count per {@link OverlaySegment}, for rendering the calibration overlay preview. */
export interface OverlayPreviewCounts {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One LED's position in the overlay's segment-ordered render sequence. */
export interface OverlayPreviewSequenceItem {
  segment: OverlaySegment;
  localIndex: number;
}

/** Full preview state pushed to the calibration overlay window. */
export interface OverlayPreviewPayload {
  counts: OverlayPreviewCounts;
  bottomMissing: number;
  cornerOwnership: "horizontal" | "vertical";
  visualPreset: "subtle" | "vivid";
  sequence: OverlayPreviewSequenceItem[];
  frameMs?: number;
  /**
   * Optional display the preview targets. When absent the backend uses the
   * previously-opened overlay display or primary as fallback. Added in v1.4
   * (Platform GAP 2) so multi-monitor test-pattern previews honor the user's
   * capture-source selection without adding a separate command surface.
   */
  displayId?: DisplayId;
}

/** One enumerated display's geometry and identity, offered for capture-source selection. */
export interface DisplayInfo {
  id: DisplayId;
  label: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor?: number;
  isPrimary: boolean;
}

/** Closed set — every `overlay_result` / `overlay_error_result` call in
 * `calibration.rs`. Do not add a frontend-only code here. */
export const DISPLAY_OVERLAY_STATUS = {
  OPENED: "OVERLAY_OPENED",
  CLOSED: "OVERLAY_CLOSED",
  OPEN_FAILED: "OVERLAY_OPEN_FAILED",
  PREVIEW_SYNCED: "OVERLAY_PREVIEW_SYNCED",
  PREVIEW_SKIPPED: "OVERLAY_PREVIEW_SKIPPED",
  PREVIEW_SYNC_FAILED: "OVERLAY_PREVIEW_SYNC_FAILED",
} as const;

/** Union of the codes in {@link DISPLAY_OVERLAY_STATUS}. */
export type DisplayOverlayStatusCode =
  (typeof DISPLAY_OVERLAY_STATUS)[keyof typeof DISPLAY_OVERLAY_STATUS];

/** Frontend-synthesised: no display to target, so no command was issued. Kept
 * out of {@link DISPLAY_OVERLAY_STATUS} so that union stays exactly the wire set. */
export const OVERLAY_NO_DISPLAY = "OVERLAY_NO_DISPLAY" as const;

/** What `DisplayTargetSnapshot.blockedCode` can hold: a wire code, or the
 * frontend's own "there was nothing to open". */
export type DisplayTargetBlockedCode =
  | DisplayOverlayStatusCode
  | typeof OVERLAY_NO_DISPLAY;

/** Coded result shape returned by the display overlay commands. */
export interface DisplayOverlayCommandResult {
  ok: boolean;
  code: DisplayOverlayStatusCode;
  message: string;
  reason?: string;
}
