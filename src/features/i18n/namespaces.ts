/** Registered i18next namespaces — one module per feature domain under `src/locales/<lang>/`. */
export const I18N_NAMESPACES = [
  "calibration",
  "common",
  "device",
  "hue",
  "lights",
  "preview",
  "roomMap",
  "settings",
  "shell",
  "telemetry",
  "tray",
  "updater",
] as const;

/** One value from {@link I18N_NAMESPACES}. */
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/** Namespace i18next falls back to when a key has no explicit prefix. */
export const I18N_DEFAULT_NS: I18nNamespace = "common";
