export const DISPLAY_OVERLAY_COMMANDS = {
  LIST_DISPLAYS: "list_displays",
  OPEN_DISPLAY_OVERLAY: "open_display_overlay",
  CLOSE_DISPLAY_OVERLAY: "close_display_overlay",
  UPDATE_DISPLAY_OVERLAY_PREVIEW: "update_display_overlay_preview",
} as const;

export type DisplayId = string;

export type OverlaySegment = "top" | "right" | "bottom" | "left";

export interface OverlayPreviewCounts {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface OverlayPreviewSequenceItem {
  segment: OverlaySegment;
  localIndex: number;
}

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

export interface DisplayOverlayCommandResult {
  ok: boolean;
  code: string;
  message: string;
  reason?: string;
}
