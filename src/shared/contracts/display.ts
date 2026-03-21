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
