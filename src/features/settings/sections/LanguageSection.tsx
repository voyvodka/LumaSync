import { useTranslation } from "react-i18next";
import { changeLanguage, I18N_SUPPORTED_LANGUAGES, type I18nLanguage } from "../../i18n/i18n";
import { shellStore } from "../../persistence/shellStore";

export function LanguageSection() {
  const { t, i18n } = useTranslation("common");
  const currentLanguage: I18nLanguage = i18n.language.toLowerCase().startsWith("tr") ? "tr" : "en";

  async function handleLanguageChange(lang: I18nLanguage) {
    if (lang === currentLanguage) return;

    await changeLanguage(lang);

    try {
      await shellStore.save({ language: lang });
    } catch {}
  }

  return (
    <section className="w-full rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("language.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">{t("language.description")}</p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={t("language.title")}>
        {I18N_SUPPORTED_LANGUAGES.map((lang) => {
          const active = currentLanguage === lang;

          return (
            <label
              key={lang}
              className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition-colors ${
                active
                  ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-slate-300 bg-transparent text-slate-700 hover:border-slate-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500"
              }`}
            >
              <input
                type="radio"
                name="language"
                value={lang}
                checked={active}
                onChange={() => {
                  void handleLanguageChange(lang);
                }}
                className="sr-only"
              />
              <span className="text-sm font-medium">{t(`language.options.${lang}`)}</span>
              <span className={`text-xs ${active ? "text-white/85 dark:text-zinc-700" : "text-slate-500 dark:text-zinc-400"}`}>
                {lang.toUpperCase()}
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
