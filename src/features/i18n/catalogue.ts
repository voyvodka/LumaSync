import type { ParseKeys } from "i18next";

import type { I18N_NAMESPACES } from "./namespaces";

/** Mirrors a translation module's shape so a missing/extra/mis-nested TR key fails to compile. */
export type Catalogue<T> = {
  [K in keyof T]: T[K] extends string ? string : Catalogue<T[K]>;
};

/** Every valid colon-qualified key (`"hue:status.pairingBody"`) — for key literals stored in data, not passed inline to `t()`. */
export type TranslationKey = ParseKeys<typeof I18N_NAMESPACES>;
