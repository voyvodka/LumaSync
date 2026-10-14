import { type MouseEvent, type ReactNode, type RefObject, useRef } from "react";
import { useTranslation } from "react-i18next";

import { furnitureColours } from "@/features/room-view/model/furnitureModel";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import type { FurnitureType } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { useHeldFlag } from "@/shared/lib/useHeldFlag";
import { IconCheck, IconImage, IconLed, IconTv } from "@/shared/ui/icons";

import type { HueAreaState } from "../../model/hueAreaState";
import { FURNITURE_TILES } from "../../model/paletteTiles";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { usePaletteKeys } from "../../state/usePaletteKeys";
import { FurnitureGlyph } from "../objects/FurnitureGlyph";
import styles from "./DockPalette.module.css";
import { Disc, Note } from "./InspectorParts";

type Press = (event: MouseEvent<HTMLButtonElement>) => void;

export interface PaletteHueArea {
  state: HueAreaState;
  zoneCount: number;
  /** Last channel-fetch code. A failed read must not look like an empty area. */
  channelsStatus: string | null;
  refreshing: boolean;
  onRefresh?: () => void;
  onNavigateToDevices?: () => void;
}

export interface DockPaletteProps {
  hasTv: boolean;
  onAddFurniture: (type: FurnitureType, event: MouseEvent<HTMLButtonElement>) => void;
  onAddTv: Press;
  /** The TV tile once there is a TV: it takes you to the one there is. */
  onSelectTv: Press;
  onAddStrip: Press;
  onAddImage: Press;
  onAddZone: Press;
  /** The Hue side of the room, when it has one: the Zone tile and the area's state beside it. */
  hue: PaletteHueArea | null;
}

/** What can be added, as two rows of tiles: the furniture, then the TV, a strip, an image and a Hue
 *  zone with the area's state at the end. */
export function DockPalette({ hasTv, onAddFurniture, onAddTv, onSelectTv, onAddStrip, onAddImage, onAddZone, hue }: DockPaletteProps) {
  const { t } = useTranslation();
  const noteRef = useRef<HTMLSpanElement | null>(null);
  const zoneReady = hue?.state.kind === "ready";
  const second = ["tv", "strip", "image", ...(hue ? ["zone"] : [])];
  const { tileProps } = usePaletteKeys([FURNITURE_TILES.map((tile) => tile.type), second]);

  return (
    <div className={styles.palette} role="toolbar" aria-label={t("roomMap:palette.label")}>
      <div className={styles.row}>
        {FURNITURE_TILES.map((tile) => {
          const name = t(`roomMap:furniture.type.${tile.type}`);
          return (
            <Tile
              key={tile.type}
              {...tileProps(tile.type)}
              label={t("roomMap:palette.add", { name })}
              title={t("roomMap:palette.size", {
                name,
                width: tile.piece.width.toFixed(1),
                depth: tile.piece.height.toFixed(1),
              })}
              testId={`palette-${tile.type}`}
              glyph={
                <FurnitureGlyph
                  model={tile.model}
                  colours={furnitureColours(tile.piece, tile.model)}
                  width={tile.piece.width}
                  depth={tile.piece.height}
                  fit
                />
              }
              onClick={(event) => onAddFurniture(tile.type, event)}
            >
              {name}
            </Tile>
          );
        })}
      </div>
      <div className={styles.row}>
        <Tile
          {...tileProps("tv")}
          label={hasTv ? t("roomMap:palette.selectTv") : t("roomMap:palette.add", { name: t("roomMap:objectPanel.tvLabel") })}
          title={hasTv ? t("roomMap:palette.selectTv") : undefined}
          testId="palette-tv"
          glyph={<span style={{ color: TYPE_DOT_COLOR.tv, display: "grid" }}>{hasTv ? <IconCheck /> : <IconTv />}</span>}
          onClick={hasTv ? onSelectTv : onAddTv}
        >
          {t("roomMap:objectPanel.tvLabel")}
        </Tile>
        <Tile
          {...tileProps("strip")}
          label={t("roomMap:palette.add", { name: t("roomMap:palette.strip") })}
          testId="palette-strip"
          glyph={<span style={{ color: TYPE_DOT_COLOR.usb, display: "grid" }}><IconLed /></span>}
          onClick={onAddStrip}
        >
          {t("roomMap:palette.strip")}
        </Tile>
        <Tile
          {...tileProps("image")}
          label={t("roomMap:palette.add", { name: t("roomMap:inspector.typeImage") })}
          testId="palette-image"
          glyph={<span style={{ color: TYPE_DOT_COLOR.image, display: "grid" }}><IconImage /></span>}
          onClick={onAddImage}
        >
          {t("roomMap:inspector.typeImage")}
        </Tile>
        {hue && (
          <>
            <Tile
              {...tileProps("zone")}
              label={t("roomMap:palette.addZone")}
              disabled={!zoneReady}
              testId="palette-zone"
              glyph={<Disc fill="var(--lm-zone-1)" />}
              // With no area to put it in, the press goes to the way to get one.
              onClick={zoneReady ? onAddZone : () => noteRef.current?.querySelector("button")?.focus()}
            >
              {t("roomMap:palette.zone")}
            </Tile>
            <AreaNote hue={hue} noteRef={noteRef} />
          </>
        )}
      </div>
    </div>
  );
}

function Tile({
  label,
  title,
  glyph,
  disabled = false,
  testId,
  onClick,
  children,
  ...roving
}: {
  label: string;
  title?: string;
  glyph: ReactNode;
  disabled?: boolean;
  testId?: string;
  onClick: Press;
  children: ReactNode;
} & ReturnType<ReturnType<typeof usePaletteKeys>["tileProps"]>) {
  return (
    <button
      type="button"
      className={cx(styles.tile, disabled && styles.unavailable)}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title ?? label}
      data-testid={testId}
      onClick={onClick}
      {...roving}
    >
      <span className={styles.glyph} aria-hidden="true">
        {glyph}
      </span>
      <span className={styles.name}>{children}</span>
    </button>
  );
}

function AreaNote({ hue, noteRef }: { hue: PaletteHueArea; noteRef: RefObject<HTMLSpanElement | null> }) {
  const { t } = useTranslation();
  const refreshing = useHeldFlag(hue.refreshing);
  const { state } = hue;

  if (state.kind !== "ready") {
    const offline = state.kind === "not-configured" && state.orphanedAreaId;
    const title =
      state.kind === "no-area"
        ? t("roomMap:hueZones.areaState.noAreaTitle")
        : offline
          ? t("roomMap:hueZones.areaState.offlineTitle")
          : t("roomMap:hueZones.areaState.notConfiguredTitle");
    const hint =
      state.kind === "no-area"
        ? t("roomMap:hueZones.areaState.noAreaHint")
        : offline
          ? t("roomMap:hueZones.areaState.offlineHint")
          : t("roomMap:hueZones.areaState.notConfiguredHint");
    return (
      <Note
        ref={noteRef}
        tone="warning"
        title={hint}
        action={
          hue.onNavigateToDevices
            ? {
                label:
                  state.kind === "no-area" ? t("roomMap:hueZones.areaState.noAreaCta") : t("roomMap:hueZones.areaState.notConfiguredCta"),
                onClick: hue.onNavigateToDevices,
              }
            : undefined
        }
      >
        {title}
      </Note>
    );
  }

  // EMPTY is a clean answer — the area really has no lights — so only the
  // genuinely unread codes may claim the screen is showing stale data.
  const empty = hue.channelsStatus === HUE_AREA_CHANNELS_STATUS.EMPTY;
  const unread = hue.channelsStatus != null && hue.channelsStatus !== HUE_AREA_CHANNELS_STATUS.OK && !empty;
  return (
    <Note
      ref={noteRef}
      tone={unread || empty ? "info" : "ok"}
      title={
        unread
          ? t("roomMap:hueZones.areaState.unreadHint")
          : empty
            ? t("roomMap:hueZones.areaState.emptyHint")
            : t("roomMap:hueZones.areaState.readyHint")
      }
      action={
        hue.onRefresh
          ? {
              label: refreshing ? t("roomMap:hueZones.areaState.refreshing") : t("roomMap:hueZones.areaState.refresh"),
              onClick: hue.onRefresh,
              pending: refreshing,
            }
          : undefined
      }
    >
      {t("roomMap:hueZones.areaState.readyTitle", { N: String(hue.zoneCount) })}
    </Note>
  );
}
