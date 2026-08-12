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

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const I18N_DEFAULT_NS: I18nNamespace = "common";
