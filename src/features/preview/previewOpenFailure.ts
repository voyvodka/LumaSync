import type { TranslationKey } from "@/features/i18n/catalogue";
import { PREVIEW_STATUS, type PreviewSessionResult } from "@/shared/contracts/preview";

/** Why the LED preview did not appear. The preview API never throws, so a
 *  failed open arrives only as a code and is easy to drop. */
export type PreviewOpenFailure = typeof PREVIEW_STATUS.OPEN_FAILED;

export const PREVIEW_OPEN_FAILURE_COPY: Record<PreviewOpenFailure, TranslationKey> = {
  [PREVIEW_STATUS.OPEN_FAILED]: "preview:status.PREVIEW_OPEN_FAILED",
};

export function previewOpenFailure(result: PreviewSessionResult): PreviewOpenFailure | null {
  switch (result.status.code) {
    case PREVIEW_STATUS.OPENED:
    case PREVIEW_STATUS.ALREADY_OPEN:
      return null;
    default:
      console.error(
        `[LumaSync] preview did not open (${result.status.code}): ${result.status.details ?? result.status.message}`,
      );
      return PREVIEW_STATUS.OPEN_FAILED;
  }
}
