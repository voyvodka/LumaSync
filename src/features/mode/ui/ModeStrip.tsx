import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { LightingModeKind } from "@/shared/contracts/mode";
import {
  getKeybindDefinition,
  resolveKeybindPlatform,
  type KeybindAction,
} from "@/shared/contracts/shell";
import { Segmented, type SegmentedOption } from "@/shared/ui/Segmented";

import { MODE_KIND_ORDER, modeKind } from "../model/modeKinds";

export type ModeStripVariant = "full" | "compact" | "popup";

interface ModeStripVariantView {
  group: string;
  item: string;
  content: (kind: LightingModeKind, text: { label: string; subtitle?: string }) => ReactNode;
  testId?: (kind: LightingModeKind) => string;
}

/** Badge text comes from `KEYBIND_REGISTRY`, the same table `useGlobalKeybinds` reads. */
function ModeKeybindBadge({ action }: { action: KeybindAction }) {
  const platform = useMemo(() => resolveKeybindPlatform(), []);
  const definition = useMemo(() => getKeybindDefinition(action, platform), [action, platform]);
  return <span className="kb">{definition.badge.join("")}</span>;
}

const VARIANTS = {
  full: {
    group: "lm-mstrip",
    item: "lm-mbtn",
    content: (kind, { label, subtitle }) => {
      const { Icon, labelLang, keybind } = modeKind(kind);
      return (
        <>
          <span className="ico"><Icon /></span>
          <span className="tx">
            <span className="tn" lang={labelLang}>{label}</span>
            {subtitle !== undefined && <span className="ts">{subtitle}</span>}
          </span>
          <ModeKeybindBadge action={keybind} />
        </>
      );
    },
  },
  compact: {
    group: "lm-compact-mode-strip",
    item: "lm-compact-mbtn",
    content: (kind, { label }) => {
      const { Icon, labelLang } = modeKind(kind);
      return (
        <>
          <span className="ico"><Icon /></span>
          <span className="tn" lang={labelLang}>{label}</span>
        </>
      );
    },
    testId: (kind) => `mode-button-${kind}`,
  },
  popup: {
    group: "lm-control-mode-strip",
    item: "lm-control-mbtn",
    content: (kind, { label }) => {
      const { PopupIcon, labelLang } = modeKind(kind);
      return (
        <>
          <span aria-hidden="true"><PopupIcon /></span>
          <span lang={labelLang}>{label}</span>
        </>
      );
    },
  },
} satisfies Record<ModeStripVariant, ModeStripVariantView>;

interface ModeStripProps {
  variant: ModeStripVariant;
  /** `null` checks nothing — the popup while a test pattern owns the light. */
  value: LightingModeKind | null;
  onSelect: (kind: LightingModeKind) => void;
  isDisabled?: (kind: LightingModeKind) => boolean;
  /** The full strip's second line per tile. */
  subtitles?: Partial<Record<LightingModeKind, string>>;
}

/** Off / Ambilight / Solid as one radio group, in each of the three windows' looks. */
export function ModeStrip({ variant, value, onSelect, isDisabled, subtitles }: ModeStripProps) {
  const { t } = useTranslation();
  const view: ModeStripVariantView = VARIANTS[variant];
  const options = MODE_KIND_ORDER.map((kind): SegmentedOption<LightingModeKind> => {
    const descriptor = modeKind(kind);
    const label = t(variant === "full" ? descriptor.titleKey : descriptor.labelKey);
    return {
      value: kind,
      label: view.content(kind, { label, subtitle: subtitles?.[kind] }),
      disabled: isDisabled?.(kind),
      testId: view.testId?.(kind),
    };
  });

  return (
    <Segmented
      options={options}
      value={value}
      onChange={onSelect}
      ariaLabel={t("common:mode.title")}
      className={view.group}
      itemClassName={view.item}
    />
  );
}
