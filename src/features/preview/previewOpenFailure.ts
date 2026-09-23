import type { TranslationKey } from "@/features/i18n/catalogue";
import {
  CONTROL_POPUP_STATUS,
  TWIN_OVERLAY_STATUS,
  type ControlPopupResult,
  type TwinOverlayResult,
} from "@/shared/contracts/preview";

/** Why the LED preview surface did not appear. The preview API never throws,
 *  so a failed open arrives only as `ok: false` and is easy to drop. */
export type PreviewOpenFailure =
  | typeof TWIN_OVERLAY_STATUS.OPEN_FAILED
  | typeof TWIN_OVERLAY_STATUS.DISPLAY_NOT_FOUND
  | typeof TWIN_OVERLAY_STATUS.UNSUPPORTED_PLATFORM_LIVE
  | typeof CONTROL_POPUP_STATUS.FAILED;

export const PREVIEW_OPEN_FAILURE_COPY: Record<PreviewOpenFailure, TranslationKey> = {
  [TWIN_OVERLAY_STATUS.OPEN_FAILED]: "preview:status.TWIN_OVERLAY_OPEN_FAILED",
  [TWIN_OVERLAY_STATUS.DISPLAY_NOT_FOUND]: "preview:status.TWIN_OVERLAY_DISPLAY_NOT_FOUND",
  [TWIN_OVERLAY_STATUS.UNSUPPORTED_PLATFORM_LIVE]: "preview:status.TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE",
  [CONTROL_POPUP_STATUS.FAILED]: "preview:status.CONTROL_POPUP_FAILED",
};

export function twinOverlayOpenFailure(result: TwinOverlayResult): PreviewOpenFailure | null {
  if (result.ok) return null;
  console.error(`[LumaSync] twin overlay did not open (${result.code}): ${result.reason ?? result.message}`);
  switch (result.code) {
    case TWIN_OVERLAY_STATUS.DISPLAY_NOT_FOUND:
    case TWIN_OVERLAY_STATUS.UNSUPPORTED_PLATFORM_LIVE:
      return result.code;
    default:
      return TWIN_OVERLAY_STATUS.OPEN_FAILED;
  }
}

export function controlPopupOpenFailure(result: ControlPopupResult): PreviewOpenFailure | null {
  if (result.ok) return null;
  console.error(`[LumaSync] control popup did not open (${result.code}): ${result.message}`);
  return CONTROL_POPUP_STATUS.FAILED;
}
