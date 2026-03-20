export const DISPLAY_OVERLAY_COMMANDS = {
  LIST_DISPLAYS: "list_displays",
  OPEN_DISPLAY_OVERLAY: "open_display_overlay",
  CLOSE_DISPLAY_OVERLAY: "close_display_overlay",
} as const;

export type DisplayId = string;

export interface DisplayInfo {
  id: DisplayId;
  label: string;
  width: number;
  height: number;
  x: number;
  y: number;
  isPrimary: boolean;
}

export interface DisplayOverlayCommandResult {
  ok: boolean;
  code: string;
  message: string;
  reason?: string;
}
