import type { en } from "@/locales";
import type { I18N_NAMESPACES } from "@/features/i18n/namespaces";

declare module "i18next" {
  interface CustomTypeOptions {
    // The full registry, not "common": i18next only type-checks colon-qualified
    // keys (`t("hue:status...")`) when the bound namespace is an array — a single
    // default namespace here would reject every cross-namespace call from a bare `useTranslation()`.
    defaultNS: typeof I18N_NAMESPACES;
    resources: typeof en;
  }
}
