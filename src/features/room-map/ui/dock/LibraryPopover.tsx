import { type MouseEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { furnitureColours } from "@/features/room-view/model/furnitureModel";
import type { FurnitureType } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { IconCheck } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

import type { LibraryCard, LibraryDrop } from "../../model/libraryDrop";
import { FURNITURE_TILES } from "../../model/paletteTiles";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { useCardDrag } from "../../state/useCardDrag";
import { usePaletteKeys } from "../../state/usePaletteKeys";
import { FurnitureGlyph } from "../objects/FurnitureGlyph";
import { HueAreaNote, type PaletteHueArea } from "./HueAreaNote";
import styles from "./LibraryPopover.module.css";

type Press = (event: MouseEvent<HTMLButtonElement>) => void;

export const LIBRARY_TABS = { FURNITURE: "furniture", LIGHT: "light", SCREEN: "screen" } as const;
export type LibraryTab = (typeof LIBRARY_TABS)[keyof typeof LIBRARY_TABS];

const COLUMNS = 5;

// For the session: the drawer opens on the shelf it was last left on.
let lastTab: LibraryTab = LIBRARY_TABS.FURNITURE;

export interface LibraryPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  hasTv: boolean;
  onAddFurniture: (type: FurnitureType, event: MouseEvent<HTMLButtonElement>) => void;
  onAddTv: Press;
  onSelectTv: Press;
  onAddStrip: Press;
  onAddZone: Press;
  hue: PaletteHueArea | null;
  /** Where a card dragged out of the drawer lands; without it the cards only click. */
  drop?: LibraryDrop;
}

interface Card {
  id: string;
  name: string;
  label: string;
  title?: string;
  glyph: ReactNode;
  disabled?: boolean;
  /** What a drag of this card carries, for the cards that can be placed by hand. */
  drag?: LibraryCard;
  onClick: Press;
}

export function LibraryPopover({ open, onClose, anchorRef, id, hasTv, onAddFurniture, onAddTv, onSelectTv, onAddStrip, onAddZone, hue, drop }: LibraryPopoverProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLSpanElement | null>(null);
  const [tab, setTabState] = useState<LibraryTab>(() => (lastTab === LIBRARY_TABS.LIGHT && !hue ? LIBRARY_TABS.FURNITURE : lastTab));
  const shown = tab === LIBRARY_TABS.LIGHT && !hue ? LIBRARY_TABS.FURNITURE : tab;
  const setTab = (next: LibraryTab) => {
    lastTab = next;
    setTabState(next);
  };
  const zoneReady = hue?.state.kind === "ready";
  const drag = useCardDrag(drop, { onStart: onClose, onAbandon: () => anchorRef.current?.focus({ preventScroll: true }) });

  const cards: Card[] =
    shown === LIBRARY_TABS.FURNITURE
      ? FURNITURE_TILES.map((tile) => {
          const name = t(`roomMap:furniture.type.${tile.type}`);
          return {
            id: tile.type,
            name,
            label: t("roomMap:palette.add", { name }),
            title: t("roomMap:palette.size", { name, width: tile.piece.width.toFixed(1), depth: tile.piece.height.toFixed(1) }),
            glyph: <FurnitureGlyph model={tile.model} colours={furnitureColours(tile.piece, tile.model)} width={tile.piece.width} depth={tile.piece.height} fit />,
            drag: { kind: "furniture", type: tile.type },
            onClick: (event) => onAddFurniture(tile.type, event),
          };
        })
      : shown === LIBRARY_TABS.LIGHT
        ? [
            {
              id: "zone",
              name: t("roomMap:palette.zone"),
              label: t("roomMap:palette.addZone"),
              glyph: <ZoneGlyph />,
              disabled: !zoneReady,
              // With no area to put it in, the press goes to the way to get one.
              onClick: zoneReady ? onAddZone : () => noteRef.current?.querySelector("button")?.focus(),
            },
          ]
        : [
            {
              id: "tv",
              name: t("roomMap:objectPanel.tvLabel"),
              label: hasTv ? t("roomMap:palette.selectTv") : t("roomMap:palette.add", { name: t("roomMap:objectPanel.tvLabel") }),
              glyph: <TvGlyph placed={hasTv} />,
              drag: hasTv ? undefined : { kind: "tv" },
              onClick: hasTv ? onSelectTv : onAddTv,
            },
            {
              id: "strip",
              name: t("roomMap:palette.strip"),
              label: t("roomMap:palette.add", { name: t("roomMap:palette.strip") }),
              glyph: <StripGlyph />,
              onClick: onAddStrip,
            },
          ];
  const rows = Array.from({ length: Math.ceil(cards.length / COLUMNS) }, (_, r) => cards.slice(r * COLUMNS, (r + 1) * COLUMNS).map((card) => card.id));
  const { tileProps } = usePaletteKeys(rows);

  // Opening lands on the shelf's tab, so the arrows pick a shelf and Tab reaches its cards.
  useEffect(() => {
    if (open) bodyRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open]);

  const tabs = [
    { value: LIBRARY_TABS.FURNITURE, label: t("roomMap:library.furniture"), testId: "library-tab-furniture" },
    ...(hue ? [{ value: LIBRARY_TABS.LIGHT, label: t("roomMap:library.light"), testId: "library-tab-light" }] : []),
    { value: LIBRARY_TABS.SCREEN, label: t("roomMap:library.screen"), testId: "library-tab-screen" },
  ];

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="above" width={520} id={id} label={t("roomMap:library.label")} role="dialog">
      <div
        ref={bodyRef}
        className={styles.body}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!open || (next && (bodyRef.current?.contains(next) || anchorRef.current?.contains(next)))) return;
          // Tabbing past either end leaves the page for the popover's portal: close, and go home.
          onClose();
          if (!next) anchorRef.current?.focus();
        }}
      >
        <Segmented className={styles.tabs} itemClassName={styles.tab} ariaLabel={t("roomMap:library.shelves")} value={shown} onChange={setTab} options={tabs} />
        <div className={styles.grid} data-testid="library-cards">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              {...tileProps(card.id)}
              className={cx(styles.card, card.disabled && styles.unavailable, drop && card.drag && styles.draggable)}
              aria-label={card.label}
              aria-disabled={card.disabled || undefined}
              title={card.title ?? card.label}
              data-testid={`palette-${card.id}`}
              onPointerDown={card.drag && drag.onPointerDown(card.drag)}
              onClick={card.onClick}
            >
              <span className={styles.glyph} aria-hidden="true">
                {card.glyph}
              </span>
              <span className={styles.name}>{card.name}</span>
            </button>
          ))}
          {shown === LIBRARY_TABS.LIGHT && hue && !zoneReady && <HueAreaNote hue={hue} noteRef={noteRef} />}
        </div>
      </div>
    </Popover>
  );
}

function TvGlyph({ placed }: { placed: boolean }) {
  return (
    <span className={styles.drawn} style={{ color: TYPE_DOT_COLOR.tv }}>
      <svg viewBox="0 0 56 36" width="56" height="36" fill="none">
        <rect x="6" y="4" width="44" height="25" rx="2" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.5" />
        <path d="M22 33h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {placed && (
        <span className={styles.badge}>
          <IconCheck />
        </span>
      )}
    </span>
  );
}

function StripGlyph() {
  return (
    <svg viewBox="0 0 56 36" width="56" height="36" fill="none" style={{ color: TYPE_DOT_COLOR.usb }}>
      <path d="M5 18h46" stroke="currentColor" strokeOpacity="0.35" strokeWidth="4" strokeLinecap="round" />
      {[8, 15, 22, 29, 36, 43, 50].map((cx) => (
        <circle key={cx} cx={cx - 1} cy="18" r="1.8" fill="currentColor" />
      ))}
    </svg>
  );
}

function ZoneGlyph() {
  return (
    <svg viewBox="0 0 56 36" width="56" height="36" fill="none" style={{ color: "var(--lm-zone-1)" }}>
      <circle cx="28" cy="18" r="14" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="28" cy="18" r="3" fill="currentColor" />
    </svg>
  );
}
