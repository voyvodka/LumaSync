/**
 * First launch with no saved language is English, deliberately — not the
 * system locale. Switching to locale detection means replacing the
 * `ENFORCE_ENGLISH_FIRST_LAUNCH` return in `resolveInitialLanguage()` with:
 *
 *   const systemLocale = navigator.language.split('-')[0];  // e.g. "tr"
 *   return isSupportedLanguage(systemLocale) ? systemLocale : I18N_DEFAULT_LANGUAGE;
 */

import { shellStore } from "../persistence/shellStore";
import type { ShellState } from "@/shared/contracts/shell";
import { changeLanguage, I18N_DEFAULT_LANGUAGE, I18N_SUPPORTED_LANGUAGES, i18next, type I18nLanguage } from "./i18n";

/**
 * Resolve the language to use on application startup.
 *
 * A supported language persisted in shell state wins; otherwise English
 * (see module header for why not the system locale).
 */
export async function resolveInitialLanguage(
  load: () => Promise<ShellState> = () => shellStore.load(),
): Promise<I18nLanguage> {
  try {
    const state = await load();
    if (isSupportedLanguage(state.language)) return state.language;
  } catch (err) {
    // Non-fatal: store unavailable (e.g., dev mode without Tauri runtime)
    // Fall through to English default.
    console.error("[LumaSync] language load from shell store failed; using default:", err);
  }

  // ── ENFORCE_ENGLISH_FIRST_LAUNCH ── see module header.
  return I18N_DEFAULT_LANGUAGE;
}

function isSupportedLanguage(value: unknown): value is I18nLanguage {
  return typeof value === "string" && (I18N_SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Keeps a secondary window on the language the user picks in Settings. The
 * control popup is hidden and reused, never rebuilt, so the language it read
 * at creation stayed until the app restarted. Returns the unsubscribe.
 */
export function followSavedLanguage(): () => void {
  return shellStore.onSaved((saved) => {
    if (!Object.prototype.hasOwnProperty.call(saved, "language")) return;
    const next = saved.language;
    if (!isSupportedLanguage(next) || next === i18next.language) return;
    changeLanguage(next).catch((err: unknown) => {
      console.error(`[LumaSync] following the saved language (${next}) failed:`, err);
    });
  });
}
