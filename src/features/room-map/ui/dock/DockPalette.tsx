import { lazy, type MouseEvent, Suspense, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FurnitureType } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { IconPlus } from "@/shared/ui/icons";

import type { LibraryDrop } from "../../model/libraryDrop";
import { usePaletteKeys } from "../../state/usePaletteKeys";
import { IconTemplates } from "./dockIcons";
import styles from "./DockPalette.module.css";
import { HueAreaNote, type PaletteHueArea } from "./HueAreaNote";

type Press = (event: MouseEvent<HTMLButtonElement>) => void;

// Its own chunk, fetched when Add is reached: the room map's chunk has no room for the drawer and its drag.
const loadLibrary = () => import("./LibraryPopover");
const LibraryPopover = lazy(() => loadLibrary().then((m) => ({ default: m.LibraryPopover })));

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
  drop?: LibraryDrop;
}

export function DockPalette({ hasTv, onAddFurniture, onAddTv, onSelectTv, onAddStrip, onAddZone, onTemplates, hue, drop }: DockPaletteProps) {
  const { t } = useTranslation();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const noteRef = useRef<HTMLSpanElement | null>(null);
  const libraryId = useId();
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
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
        onPointerEnter={() => void loadLibrary()}
        onClick={() => {
          setWanted(true);
          setOpen((was) => !was);
        }}
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
      {wanted && (
        <Suspense fallback={null}>
          <LibraryPopover
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={addRef}
            id={libraryId}
            hasTv={hasTv}
            hue={hue}
            drop={drop}
            onAddFurniture={closing(onAddFurniture)}
            onAddTv={closing(onAddTv)}
            onSelectTv={closing(onSelectTv)}
            onAddStrip={closing(onAddStrip)}
            onAddZone={closing(onAddZone)}
          />
        </Suspense>
      )}
    </div>
  );
}
