import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";

import { i18next } from "@/features/i18n/i18n";
import { showNotification } from "@/features/platform/platformApi";
import {
  LIGHTING_ORIGIN,
  LIGHTING_OUTPUTS_STATUS,
  type LightingOutcome,
} from "@/shared/contracts/lightingRuntime";

import { choiceFailureMessage } from "./notices/choiceFailureMessage";
import { isWindowVisible } from "./windowVisibility";

/** The same failure again within this long is the same news: one toast, not one per click. */
export const TRAY_FAILURE_COALESCE_MS = 60_000;

/**
 * A tray choice that fell short while the main window is hidden raises an OS
 * notification: the tray has no surface of its own, and the notice the main
 * window raises for it sits in a window nobody is looking at. A visible
 * window's notice is enough, and a choice that ran needs no word at all.
 * Main window only — `isWindowVisible` reads the main window.
 */
export function useTrayFailureNotification(lastOutcome: LightingOutcome | null | undefined): void {
  const handledRef = useRef<number | null>(null);
  const lastToastRef = useRef<{ message: string; at: number } | null>(null);

  useEffect(() => {
    if (lastOutcome === undefined) return;
    const handled = handledRef.current;
    // The first snapshot is the baseline, as in the orchestrator: an answer
    // from before this window was open is not news.
    if (handled === null) {
      handledRef.current = lastOutcome?.requestId ?? 0;
      return;
    }
    if (lastOutcome === null || lastOutcome.requestId <= handled) return;
    handledRef.current = lastOutcome.requestId;
    if (lastOutcome.origin !== LIGHTING_ORIGIN.TRAY) return;

    const t = i18next.t.bind(i18next) as TFunction;
    const message = choiceFailureMessage(lastOutcome, t);
    if (message === null) {
      lastToastRef.current = null;
      return;
    }
    if (isWindowVisible()) return;
    const now = Date.now();
    const last = lastToastRef.current;
    if (last !== null && last.message === message && now - last.at < TRAY_FAILURE_COALESCE_MS) return;
    lastToastRef.current = { message, at: now };

    const partial = lastOutcome.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_APPLIED_PARTIAL;
    showNotification({ title: t("tray:outcomeTitle"), body: message, kind: partial ? "warn" : "error" })
      .then((result) => {
        if (result.status !== "shown") {
          console.warn(`[LumaSync] the tray failure notification was not shown: ${result.status}`);
        }
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] the tray failure notification failed:", error);
      });
  }, [lastOutcome]);
}
