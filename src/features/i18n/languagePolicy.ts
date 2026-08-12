/**
 * Language Policy — Phase 1 Baseline
 *
 * Determines the initial language for the application on startup.
 *
 * ─── I18N-02 Requirement (current) ────────────────────────────────────────
 * "User sees English on first launch with no saved language."
 * Source of truth: REQUIREMENTS.md I18N-02, ROADMAP.md Phase 1 acceptance.
 *
 * ─── Context preference note (future) ─────────────────────────────────────
 * The 01-CONTEXT.md discusses using system locale as the first-launch default.
 * That preference is intentionally NOT implemented here because I18N-02 is the
 * binding acceptance criterion for Phase 1.
 *
 * ─── Switch-point for future migration ────────────────────────────────────
 * When I18N-02 is updated or a new requirement captures the system-locale
 * preference, replace the `ENFORCE_ENGLISH_FIRST_LAUNCH` block in
 * `resolveInitialLanguage()` with:
 *
 *   const systemLocale = navigator.language.split('-')[0];  // e.g. "tr"
 *   return SUPPORTED_LANGUAGES.includes(systemLocale) ? systemLocale : DEFAULT_LANGUAGE;
 *
 * That single block swap is the complete migration path.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { shellStore } from "../persistence/shellStore";

// ---------------------------------------------------------------------------
// Supported language codes
// ---------------------------------------------------------------------------

/** Languages shipped in Phase 1 locale bundles */
export const SUPPORTED_LANGUAGES = ["en", "tr"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Default language enforced by I18N-02 for first launch */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Resolve the language to use on application startup.
 *
 * Resolution order (Phase 1 / I18N-02 compliant):
 *  1. If a supported language is persisted in shell state → use it.
 *  2. Otherwise → return `"en"` (enforces I18N-02 English-first requirement).
 *
 * Note: System-locale auto-detection is intentionally deferred (see module
 * header) until I18N-02 acceptance criterion is revised.
 */
export async function resolveInitialLanguage(): Promise<SupportedLanguage> {
  try {
    const state = await shellStore.load();
    const persisted = state.language;

    // If a supported language is explicitly saved, honour the user's choice.
    if (persisted && (SUPPORTED_LANGUAGES as readonly string[]).includes(persisted)) {
      return persisted as SupportedLanguage;
    }
  } catch {
    // Non-fatal: store unavailable (e.g., dev mode without Tauri runtime)
    // Fall through to English default.
  }

  // ── ENFORCE_ENGLISH_FIRST_LAUNCH ──
  // I18N-02 acceptance criterion: English on first launch.
  // See module header for future switch-point.
  return DEFAULT_LANGUAGE;
}
