import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DisplayInfo } from "@/shared/contracts/display";
import { Popover } from "@/shared/ui/Popover/Popover";
import { DisplayMenu } from "./DisplayMenu";
import styles from "./SetupTopBar.module.css";

interface SetupTopBarProps {
  displays: DisplayInfo[];
  selectedDisplayId: string | null | undefined;
  switching: boolean;
  onSelectDisplay: (display: DisplayInfo) => void;
  /** Where a running test goes: the strip, or only the on-screen twin. Null while none runs. */
  testTarget: "strip" | "preview" | null;
  previewDisabled: boolean;
  onPreview: () => void;
}

/** The captured display on the left; where a test goes, Preview and help on the right. */
export function SetupTopBar({
  displays,
  selectedDisplayId,
  switching,
  onSelectDisplay,
  testTarget,
  previewDisabled,
  onPreview,
}: SetupTopBarProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.bar}>
      <DisplayMenu displays={displays} selectedId={selectedDisplayId} busy={switching} onSelect={onSelectDisplay} />
      <span className={styles.spacer} />
      {testTarget && (
        <span className={testTarget === "preview" ? `${styles.status} ${styles.isPreview}` : styles.status}>
          {testTarget === "preview" ? t("calibration:overlay.previewOnly") : t("calibration:overlay.outputActive")}
        </span>
      )}
      <button type="button" disabled={previewDisabled} onClick={onPreview} className={styles.button}>
        <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="12" rx="2" />
          <path d="M9 20h6M12 16.5V20" />
        </svg>
        {t("calibration:setup.preview")}
      </button>
      <Help label={t("calibration:setup.help")}>
        <ul className={styles.help}>
          {HELP.map(({ key, glyph }) => (
            <li key={key}>
              <svg viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {glyph}
              </svg>
              {t(key)}
            </li>
          ))}
        </ul>
      </Help>
    </div>
  );
}

/** One line per thing on the page, each led by a small picture of it. */
const HELP = [
  {
    key: "calibration:setup.helpNumbers",
    glyph: (
      <>
        <path d="M3 6h14" strokeDasharray="0.1 3" strokeWidth="2.4" />
        <path d="M7 13h6M10 10v6" />
      </>
    ),
  },
  { key: "calibration:setup.helpFlow", glyph: <path d="M4 5h11v9m-3-3 3 3 3-3" className={styles.amber} /> },
  { key: "calibration:setup.helpTest", glyph: <path d="M7 5.5v9l7-4.5z" /> },
  {
    key: "calibration:setup.helpPreview",
    glyph: (
      <>
        <rect x="3" y="4" width="14" height="9.5" rx="1.5" />
        <path d="M8 16.5h4" />
      </>
    ),
  },
] as const;

/** A short explanation behind a quiet "?" — the page itself shows only values and actions. */
function Help({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`${styles.button} ${styles.icon}`}
      >
        <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.5-2.2 1.9-2.2 3.3" />
          <circle cx="12" cy="16.9" r=".4" fill="currentColor" />
        </svg>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} side="below" width={250} id={id} label={label} role="dialog">
        {children}
      </Popover>
    </>
  );
}
