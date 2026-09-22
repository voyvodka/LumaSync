/**
 * First launch with no saved language is English, deliberately — not the
 * system locale. Switching to locale detection means replacing the
 * `ENFORCE_ENGLISH_FIRST_LAUNCH` return in `resolveInitialLanguage()` with:
 *
 *   const systemLocale = navigator.language.split('-')[0];  // e.g. "tr"
 *   return SUPPORTED_LANGUAGES.includes(systemLocale) ? systemLocale : DEFAULT_LANGUAGE;
 */

import { shellStore } from "../persistence/shellStore";

// ---------------------------------------------------------------------------
// Supported language codes
// ---------------------------------------------------------------------------

/** Languages with a shipped locale bundle. */
export const SUPPORTED_LANGUAGES = ["en", "tr"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** First-launch language when nothing is saved. */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Resolve the language to use on application startup.
 *
 * A supported language persisted in shell state wins; otherwise English
 * (see module header for why not the system locale).
 */
export async function resolveInitialLanguage(): Promise<SupportedLanguage> {
  try {
    const state = await shellStore.load();
    const persisted = state.language;

    // If a supported language is explicitly saved, honour the user's choice.
    if (persisted && (SUPPORTED_LANGUAGES as readonly string[]).includes(persisted)) {
      return persisted as SupportedLanguage;
    }
  } catch (err) {
    // Non-fatal: store unavailable (e.g., dev mode without Tauri runtime)
    // Fall through to English default.
    console.error("[LumaSync] language load from shell store failed; using default:", err);
  }

  // ── ENFORCE_ENGLISH_FIRST_LAUNCH ── see module header.
  return DEFAULT_LANGUAGE;
}
