/**
 * Language Section
 *
 * Provides immediate runtime language switching (no restart required).
 *
 * Behaviour:
 *  - Reads current language from i18next instance
 *  - Renders EN / TR radio options
 *  - On change: calls i18next.changeLanguage() (immediate UI update via react-i18next)
 *    and persists the selection to shellStore so it is restored on next launch
 *
 * Dependencies:
 *  - react-i18next: useTranslation, useI18n
 *  - languagePolicy: SUPPORTED_LANGUAGES, SupportedLanguage
 *  - shellStore: persist user selection
 */

import { useTranslation } from "react-i18next";
import { changeLanguage, I18N_SUPPORTED_LANGUAGES, type I18nLanguage } from "../../i18n/i18n";
import { shellStore } from "../../persistence/shellStore";

// Labels for each language option (static, not translated — always legible regardless of current language)
const LANGUAGE_LABELS: Record<I18nLanguage, string> = {
  en: "English",
  tr: "Türkçe",
};

export function LanguageSection() {
  const { t, i18n } = useTranslation("common");
  const currentLanguage = i18n.language as I18nLanguage;

  async function handleLanguageChange(lang: I18nLanguage) {
    if (lang === currentLanguage) return;

    // 1. Switch i18next language — react-i18next re-renders all consumers immediately
    await changeLanguage(lang);

    // 2. Persist selection so the correct language is restored on next launch
    try {
      await shellStore.save({ language: lang });
    } catch {
      // Non-fatal: persistence failure doesn't break the UI switch
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">{t("language.title")}</h2>
      <p className="settings-section__description">{t("language.description")}</p>

      <div className="language-options" role="radiogroup" aria-label={t("language.title")}>
        {I18N_SUPPORTED_LANGUAGES.map((lang) => (
          <label key={lang} className="language-option">
            <input
              type="radio"
              name="language"
              value={lang}
              checked={currentLanguage === lang}
              onChange={() => { void handleLanguageChange(lang); }}
            />
            <span className="language-option__label">{LANGUAGE_LABELS[lang]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
