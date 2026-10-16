import { type MouseEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FurnitureType } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { IconPlus } from "@/shared/ui/icons";

import { usePaletteKeys } from "../../state/usePaletteKeys";
import { IconTemplates } from "./dockIcons";
import styles from "./DockPalette.module.css";
import { HueAreaNote, type PaletteHueArea } from "./HueAreaNote";
import { LibraryPopover } from "./LibraryPopover";

type Press = (event: MouseEvent<HTMLButtonElement>) => void;

export interface DockPaletteProps {
  hasTv: boolean;
  onAddFurniture: (type: FurnitureType, event: MouseEvent<HTMLButtonElement>) => void;
  onAddTv: Press;
  /** The TV card once there is a TV: it takes you to the one there is. */
  onSelectTv: Press;
  onAddStrip: Press;
  onAddZone: Press;
  /** Opens the room templates, where the editor offers them. */
  onTemplates?: Press;
  hue: PaletteHueArea | null;
}

export function DockPalette({ hasTv, onAddFurniture, onAddTv, onSelectTv, onAddStrip, onAddZone, onTemplates, hue }: DockPaletteProps) {
  const { t } = useTranslation();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLSpanElement | null>(null);
  const libraryId = useId();
  const [open, setOpen] = useState(false);
  const { tileProps } = usePaletteKeys([["add", ...(onTemplates ? ["templates"] : [])]]);
  const closing =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) => {
      setOpen(false);
      run(...args);
    };

  return (
    <div className={styles.palette} role="toolbar" aria-label={t("roomMap:palette.label")}>
      <button
        type="button"
        ref={(element) => {
          addRef.current = element;
          tileProps("add").ref(element);
        }}
        tabIndex={tileProps("add").tabIndex}
        onKeyDown={tileProps("add").onKeyDown}
        onFocus={tileProps("add").onFocus}
        className={cx(styles.action, open && styles.open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? libraryId : undefined}
        data-testid="palette-add"
        onClick={() => setOpen((was) => !was)}
      >
        <span className={styles.glyph} aria-hidden="true">
          <IconPlus />
        </span>
        {t("roomMap:dock.add")}
      </button>
      {onTemplates && (
        <button
          type="button"
          {...tileProps("templates")}
          className={styles.action}
          title={t("roomMap:palette.templatesHint")}
          data-testid="palette-templates"
          onClick={onTemplates}
        >
          <span className={styles.glyph} aria-hidden="true">
            <IconTemplates />
          </span>
          {t("roomMap:palette.templates")}
        </button>
      )}
      {hue && (
        <span className={styles.note}>
          <HueAreaNote hue={hue} noteRef={noteRef} />
        </span>
      )}
      <LibraryPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={addRef}
        id={libraryId}
        hasTv={hasTv}
        hue={hue}
        onAddFurniture={closing(onAddFurniture)}
        onAddTv={closing(onAddTv)}
        onSelectTv={closing(onSelectTv)}
        onAddStrip={closing(onAddStrip)}
        onAddZone={closing(onAddZone)}
      />
    </div>
  );
}
