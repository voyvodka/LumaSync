import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { Popover } from "@/shared/ui/Popover/Popover";

import { ROOM_TEMPLATES } from "../../model/roomTemplates";
import { templateFacts } from "../../model/templateFacts";
import { usePaletteKeys } from "../../state/usePaletteKeys";
import { RoomPreview } from "../RoomPreview";
import styles from "./TemplatesPopover.module.css";

// A sweep across the cards on the way to one would build every room it crossed.
export const PREVIEW_INTENT_MS = 160;

export interface TemplatesPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  onPreview: (template: RoomMapConfig | null) => void;
  onApply: (template: RoomMapConfig, name: string) => void;
}

export function TemplatesPopover({ open, onClose, anchorRef, id, onPreview, onApply }: TemplatesPopoverProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const templates = useMemo(
    () => ROOM_TEMPLATES.map((template) => {
      const built = template.config(t);
      return { ...template, built, facts: templateFacts(built, t, language) };
    }),
    [t, language],
  );
  const { tileProps } = usePaletteKeys([templates.map((template) => template.id)]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const intent = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  // Opening is not a change: the focus the drawer lands on shows nothing until it moves.
  const landing = useRef(false);
  const want = (id: string | null, template: RoomMapConfig | null) => {
    if (intent.current !== null) clearTimeout(intent.current);
    // The pointer leaves the cards as they animate out: a preview from then would outlive the drawer.
    if (!open) return;
    intent.current = setTimeout(() => {
      intent.current = null;
      setPreviewed(id);
      onPreview(template);
    }, PREVIEW_INTENT_MS);
  };
  useEffect(() => {
    if (open) {
      landing.current = true;
      gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
      landing.current = false;
    } else {
      if (intent.current !== null) clearTimeout(intent.current);
      intent.current = null;
      setPreviewed(null);
    }
  }, [open]);
  useEffect(
    () => () => {
      if (intent.current !== null) clearTimeout(intent.current);
    },
    [],
  );

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="above" width={540} id={id} label={t("roomMap:palette.templates")} role="dialog">
      <div
        ref={gridRef}
        className={styles.grid}
        data-testid="templates-cards"
        onPointerLeave={() => want(null, null)}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!open || (next && (gridRef.current?.contains(next) || anchorRef.current?.contains(next)))) return;
          onClose();
          if (!next) anchorRef.current?.focus();
        }}
      >
        {templates.map((template) => {
          const keys = tileProps(template.id);
          return (
            <button
              key={template.id}
              type="button"
              {...keys}
              onFocus={() => {
                keys.onFocus();
                if (!landing.current) want(template.id, template.built);
              }}
              onPointerEnter={() => want(template.id, template.built)}
              className={styles.card}
              data-previewing={previewed === template.id || undefined}
              aria-describedby={`${id}-${template.id}`}
              title={t(template.descKey)}
              data-testid={`template-${template.id}`}
              onClick={() => {
                if (intent.current !== null) clearTimeout(intent.current);
                onApply(template.built, t(template.nameKey));
              }}
            >
              <span className={styles.thumb} aria-hidden="true">
                <RoomPreview config={template.built} />
              </span>
              <span className={styles.name}>{t(template.nameKey)}</span>
              <span className={styles.facts}>{template.facts}</span>
              <span id={`${id}-${template.id}`} hidden>
                {t(template.descKey)}
              </span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
