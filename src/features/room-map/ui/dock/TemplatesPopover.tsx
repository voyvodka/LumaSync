import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { Popover } from "@/shared/ui/Popover/Popover";

import { ROOM_TEMPLATES } from "../../model/roomTemplates";
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
  onApply: (template: RoomMapConfig) => void;
}

export function TemplatesPopover({ open, onClose, anchorRef, id, onPreview, onApply }: TemplatesPopoverProps) {
  const { t } = useTranslation();
  const templates = useMemo(() => ROOM_TEMPLATES.map((template) => ({ ...template, built: template.config(t) })), [t]);
  const { tileProps } = usePaletteKeys([templates.map((template) => template.id)]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const intent = useRef<ReturnType<typeof setTimeout> | null>(null);
  const want = (template: RoomMapConfig | null) => {
    if (intent.current !== null) clearTimeout(intent.current);
    intent.current = setTimeout(() => {
      intent.current = null;
      onPreview(template);
    }, PREVIEW_INTENT_MS);
  };
  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    else if (intent.current !== null) clearTimeout(intent.current);
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
        onPointerLeave={() => want(null)}
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
                want(template.built);
              }}
              onPointerEnter={() => want(template.built)}
              className={styles.card}
              aria-label={t(template.nameKey)}
              aria-describedby={`${id}-${template.id}`}
              title={t(template.descKey)}
              data-testid={`template-${template.id}`}
              onClick={() => {
                if (intent.current !== null) clearTimeout(intent.current);
                onApply(template.built);
              }}
            >
              <span className={styles.thumb} aria-hidden="true">
                <RoomPreview config={template.built} />
              </span>
              <span className={styles.name}>{t(template.nameKey)}</span>
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
