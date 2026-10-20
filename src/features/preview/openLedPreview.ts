import { openPreview } from "./previewApi";
import { previewOpenFailure, type PreviewOpenFailure } from "./previewOpenFailure";

/** Opens the preview session — what the tray's "LED preview" item and Lights' preview action do.
 *  Answers the failure to act on, or `null`. */
export async function openLedPreview(): Promise<PreviewOpenFailure | null> {
  return previewOpenFailure(await openPreview());
}
