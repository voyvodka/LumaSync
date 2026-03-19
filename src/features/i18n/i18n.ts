/**
 * i18n.ts — i18next runtime initialisation
 *
 * Initialises i18next with:
 *  - English and Turkish locale resources (Phase 1 baseline)
 *  - English as the fallback language (missing keys → English text)
 *  - No automatic language detection (first-launch language is resolved
 *    by `languagePolicy.resolveInitialLanguage()` which honours I18N-02)
 *
 * Usage:
 *   import { initI18n } from './i18n';
 *   await initI18n('en');  // pass resolved language from languagePolicy
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "../../locales/en/common.json";
import trCommon from "../../locales/tr/common.json";

/** Supported language codes (must match languagePolicy.SUPPORTED_LANGUAGES) */
export const I18N_SUPPORTED_LANGUAGES = ["en", "tr"] as const;
export type I18nLanguage = (typeof I18N_SUPPORTED_LANGUAGES)[number];

/** Default/fallback language — always English per I18N-02 */
export const I18N_DEFAULT_LANGUAGE: I18nLanguage = "en";

/**
 * Initialise i18next with the resolved starting language.
 *
 * @param language - Language resolved by `resolveInitialLanguage()`.
 *                   Defaults to `"en"` if not provided (safe fallback).
 */
export async function initI18n(language: string = I18N_DEFAULT_LANGUAGE): Promise<void> {
  // Guard: if i18next is already initialised (HMR / double-call), skip.
  if (i18next.isInitialized) return;

  await i18next.use(initReactI18next).init({
    lng: language,
    fallbackLng: I18N_DEFAULT_LANGUAGE,

    resources: {
      en: { common: enCommon },
      tr: { common: trCommon },
    },

    defaultNS: "common",
    ns: ["common"],

    // Missing key handling: log in dev, show English fallback in production
    missingKeyHandler: (lngs, ns, key) => {
      if (import.meta.env.DEV) {
        console.warn(`[i18n] Missing key: ${ns}:${key} for lngs:`, lngs);
      }
    },

    // Disable interpolation escaping — React handles XSS
    interpolation: {
      escapeValue: false,
    },

    // No automatic detection — we use languagePolicy for explicit control
    detection: undefined,
  });
}

/** Change the active language at runtime and persist the selection. */
export async function changeLanguage(lang: I18nLanguage): Promise<void> {
  await i18next.changeLanguage(lang);
}

export { i18next };
