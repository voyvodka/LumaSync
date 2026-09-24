/**
 * i18n.ts — i18next runtime initialisation
 *
 * Initialises i18next with:
 *  - Only the active language's catalogue; the other one is fetched when the
 *    user switches (see docs/architecture/ui-and-shell.md, "Per-window bundles")
 *  - English as the fallback language
 *  - No automatic language detection (first-launch language is resolved
 *    by `languagePolicy.resolveInitialLanguage()` which honours I18N-02)
 *
 * Usage:
 *   import { initI18n } from './i18n';
 *   await initI18n('en');  // pass resolved language from languagePolicy
 */

import i18next, { type ResourceLanguage } from "i18next";
import { initReactI18next } from "react-i18next";

import { I18N_DEFAULT_NS, I18N_NAMESPACES } from "./namespaces";

/** Supported language codes (must match languagePolicy.SUPPORTED_LANGUAGES) */
export const I18N_SUPPORTED_LANGUAGES = ["en", "tr"] as const;
export type I18nLanguage = (typeof I18N_SUPPORTED_LANGUAGES)[number];

/** Endonyms — a language names itself, so the picker reads to its own speaker
 * whatever locale the interface is currently in. */
export const I18N_LANGUAGE_NAMES: Record<I18nLanguage, string> = {
  en: "English",
  tr: "Türkçe",
};

/** Default/fallback language — always English per I18N-02 */
export const I18N_DEFAULT_LANGUAGE: I18nLanguage = "en";

// One chunk per language. A TR window does not fetch the EN fallback too:
// key parity is a CI gate, so the fallback is never reached.
const LOCALE_LOADERS: Record<I18nLanguage, () => Promise<ResourceLanguage>> = {
  en: () => import("@/locales/en").then((m) => m.default),
  tr: () => import("@/locales/tr").then((m) => m.default),
};

function toSupportedLanguage(language: string): I18nLanguage {
  return (I18N_SUPPORTED_LANGUAGES as readonly string[]).includes(language)
    ? (language as I18nLanguage)
    : I18N_DEFAULT_LANGUAGE;
}

async function ensureLanguageLoaded(language: I18nLanguage): Promise<void> {
  if (i18next.hasResourceBundle(language, I18N_DEFAULT_NS)) return;
  const catalogue = await LOCALE_LOADERS[language]();
  for (const [namespace, bundle] of Object.entries(catalogue)) {
    i18next.addResourceBundle(language, namespace, bundle, true, true);
  }
}

/**
 * Initialise i18next with the resolved starting language.
 *
 * @param language - Language resolved by `resolveInitialLanguage()`.
 *                   Defaults to `"en"` if not provided (safe fallback).
 */
export async function initI18n(language: string = I18N_DEFAULT_LANGUAGE): Promise<void> {
  // Guard: if i18next is already initialised (HMR / double-call), skip.
  if (i18next.isInitialized) return;

  const lng = toSupportedLanguage(language);
  const catalogue = await LOCALE_LOADERS[lng]();

  await i18next.use(initReactI18next).init({
    lng,
    fallbackLng: I18N_DEFAULT_LANGUAGE,

    resources: { [lng]: catalogue },

    defaultNS: I18N_DEFAULT_NS,
    ns: [...I18N_NAMESPACES],
    // fallbackNS deliberately unset: a missing key must reach missingKeyHandler
    // rather than being silently rescued from a sibling namespace.

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

  syncDocumentLanguage();
}

/**
 * Keeps `<html lang>` on the language actually being rendered.
 *
 * `index.html` ships `lang="en"` and nothing updated it, so the whole Turkish
 * UI was announced to a screen reader as English — it applies English
 * pronunciation rules to Turkish text, which is the difference between
 * understandable and not. Hooked to `languageChanged` rather than written at
 * each call site so the runtime switch and the boot path cannot diverge.
 */
function syncDocumentLanguage(): void {
  const apply = (lang: string) => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  };
  apply(i18next.resolvedLanguage ?? i18next.language ?? I18N_DEFAULT_LANGUAGE);
  i18next.on("languageChanged", apply);
}

/**
 * Change the active language at runtime. The catalogue loads first: switching
 * before it is in would render raw keys until it arrived.
 */
export async function changeLanguage(lang: I18nLanguage): Promise<void> {
  await ensureLanguageLoaded(lang);
  await i18next.changeLanguage(lang);
}

export { i18next };
