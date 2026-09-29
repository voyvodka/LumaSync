import type { ComponentType } from "react";

import type { TranslationKey } from "@/features/i18n/catalogue";
import {
  LIGHTING_MODE_KIND,
  type AmbilightPayload,
  type EffectPayload,
  type LightingModeConfig,
  type LightingModeKind,
  type SolidColorPayload,
} from "@/shared/contracts/mode";
import { KEYBIND_ACTIONS, type KeybindAction } from "@/shared/contracts/shell";
import { IconAmbilight, IconEffect, IconOff, IconSolid, IconSolidDot } from "@/shared/ui/icons";

export interface ModeKindDescriptor {
  keybind: KeybindAction;
  /** The short label the compact strip and the popup show. */
  labelKey: TranslationKey;
  /** The full Lights page's tile title. */
  titleKey: TranslationKey;
  /** "Ambilight" is a brand: English casing, or `lang="tr"` uppercases it to "AMBİLİGHT". */
  labelLang?: "en";
  Icon: ComponentType;
  /** The popup draws Solid as a plain disc. */
  PopupIcon: ComponentType;
  /** The config a click on this kind applies, from whatever payloads the caller has on screen. */
  config: (payloads: {
    solid?: SolidColorPayload;
    ambilight?: AmbilightPayload;
    effect?: EffectPayload;
  }) => LightingModeConfig;
}

/** Strip order: left to right in every mode strip, and the ⌥1–⌥4 keybind order. */
export const MODE_KIND_ORDER = [
  LIGHTING_MODE_KIND.OFF,
  LIGHTING_MODE_KIND.AMBILIGHT,
  LIGHTING_MODE_KIND.SOLID,
  LIGHTING_MODE_KIND.EFFECT,
] as const satisfies readonly LightingModeKind[];

/** The modes the strip offers beside the power button: every one that lights something. */
export const LIT_MODE_ORDER = MODE_KIND_ORDER.filter(
  (kind): kind is Exclude<(typeof MODE_KIND_ORDER)[number], "off"> => kind !== LIGHTING_MODE_KIND.OFF,
);

/** A new lighting mode kind fails to compile here until every strip can draw it. */
export const MODE_KINDS = {
  [LIGHTING_MODE_KIND.OFF]: {
    keybind: KEYBIND_ACTIONS.MODE_OFF,
    labelKey: "common:mode.options.off",
    titleKey: "lights:mode.off.title",
    Icon: IconOff,
    PopupIcon: IconOff,
    config: () => ({ kind: LIGHTING_MODE_KIND.OFF }),
  },
  [LIGHTING_MODE_KIND.AMBILIGHT]: {
    keybind: KEYBIND_ACTIONS.MODE_AMBILIGHT,
    labelKey: "common:mode.options.ambilight",
    titleKey: "lights:mode.ambilight.title",
    labelLang: "en",
    Icon: IconAmbilight,
    PopupIcon: IconAmbilight,
    // Without a payload Rust keeps the last Ambilight settings.
    config: ({ ambilight }) =>
      ambilight
        ? { kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight }
        : { kind: LIGHTING_MODE_KIND.AMBILIGHT },
  },
  [LIGHTING_MODE_KIND.SOLID]: {
    keybind: KEYBIND_ACTIONS.MODE_SOLID,
    labelKey: "common:mode.options.solid",
    titleKey: "lights:mode.solid.title",
    Icon: IconSolid,
    PopupIcon: IconSolidDot,
    // Without a payload Rust keeps the last colour.
    config: ({ solid }) =>
      solid ? { kind: LIGHTING_MODE_KIND.SOLID, solid } : { kind: LIGHTING_MODE_KIND.SOLID },
  },
  [LIGHTING_MODE_KIND.EFFECT]: {
    keybind: KEYBIND_ACTIONS.MODE_EFFECT,
    labelKey: "common:mode.options.effect",
    titleKey: "lights:mode.effect.title",
    Icon: IconEffect,
    PopupIcon: IconEffect,
    // Without a payload Rust keeps the last effect.
    config: ({ effect }) =>
      effect ? { kind: LIGHTING_MODE_KIND.EFFECT, effect } : { kind: LIGHTING_MODE_KIND.EFFECT },
  },
} satisfies Record<LightingModeKind, ModeKindDescriptor>;

export function modeKind(kind: LightingModeKind): ModeKindDescriptor {
  return MODE_KINDS[kind];
}
