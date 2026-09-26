import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DisplayInfo } from "@/shared/contracts/display";
import { PickerList } from "../dock/PickerList";
import { displayName } from "./displayName";
import styles from "./DisplayMenu.module.css";

interface DisplayMenuProps {
  displays: DisplayInfo[];
  selectedId: string | null | undefined;
  /** A switch or test toggle in flight: the menu still opens, a pick is ignored by the session. */
  busy: boolean;
  onSelect: (display: DisplayInfo) => void;
}

/** The screen's outline at its own shape, so a portrait or ultrawide display reads as one. */
function DisplayGlyph({ display }: { display: DisplayInfo }) {
  const ratio = display.height / Math.max(1, display.width);
  const w = ratio > 1 ? 11 : 18;
  const h = Math.max(6, Math.min(16, Math.round(w * ratio)));
  return <span aria-hidden className={styles.glyph} style={{ width: w, height: h }} />;
}

/** The captured display: its name as a title, and a pick list when there is more than one. */
export function DisplayMenu({ displays, selectedId, busy, onSelect }: DisplayMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const selected = displays.find((d) => d.id === selectedId) ?? displays[0];

  if (!selected) return <span className={styles.none}>{t("calibration:overlay.noDisplays")}</span>;

  const title = (
    <>
      <DisplayGlyph display={selected} />
      <span className={styles.name}>{displayName(selected, displays, t)}</span>
      <span className={styles.size}>
        {selected.width}×{selected.height}
      </span>
    </>
  );

  if (displays.length < 2) {
    return (
      <span className={styles.title} aria-label={t("calibration:setup.displayLabel")}>
        {title}
      </span>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("calibration:setup.displayLabel")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-busy={busy || undefined}
        onClick={() => setOpen((v) => !v)}
        className={styles.trigger}
      >
        {title}
        <svg aria-hidden viewBox="0 0 12 12" className={open ? `${styles.chevron} ${styles.isOpen}` : styles.chevron}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <PickerList
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        side="below"
        id={listId}
        label={t("calibration:setup.displayLabel")}
        width={300}
        items={displays}
        itemKey={(d) => d.id}
        selectedIndex={displays.findIndex((d) => d.id === selected.id)}
        renderItem={(d) => (
          <span className={styles.row}>
            <DisplayGlyph display={d} />
            <span className={styles.name}>{displayName(d, displays, t)}</span>
            <span className={styles.size}>
              {d.width}×{d.height}
            </span>
          </span>
        )}
        onPick={(i) => {
          const d = displays[i];
          setOpen(false);
          buttonRef.current?.focus();
          if (d && !busy && d.id !== selected.id) onSelect(d);
        }}
      />
    </>
  );
}
