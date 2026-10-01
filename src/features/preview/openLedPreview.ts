import { shellStore } from "@/features/persistence/shellStore";
import { openLedControlPopup, openLedTwinOverlay, showLedControlPopup } from "./previewApi";
import { controlPopupOpenFailure, twinOverlayOpenFailure, type PreviewOpenFailure } from "./previewOpenFailure";

/**
 * Opens (or brings forward) the LED control popup and, when it is switched on, the twin overlay —
 * what the tray's "LED preview" item and Lights' preview action both do. Answers the first failure,
 * the one to act on, or `null`.
 */
export async function openLedPreview(): Promise<PreviewOpenFailure | null> {
  const popupFailure =
    controlPopupOpenFailure(await openLedControlPopup()) ?? controlPopupOpenFailure(await showLedControlPopup());
  if (popupFailure === null) await shellStore.save({ ledPreviewPopupVisible: true });
  const state = await shellStore.load();
  const overlayFailure = state.ledTwinEnabledTest
    ? twinOverlayOpenFailure(
        await openLedTwinOverlay({ scope: "test", displayId: state.selectedDisplayId || undefined }),
      )
    : null;
  return popupFailure ?? overlayFailure;
}
