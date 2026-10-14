import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

import { hueChannelIdLabel, hueChannelName } from "../../model/hueChannelLabel";
import { hueToMetres, hueToPlanMetres, planMetresToHue } from "../../model/hueChannelPosition";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import type { UsbStripConnectionStatus } from "./UsbStripInspector";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { DecimalField, FieldPair } from "../DecimalField";

function heightBandKey(
  worldZ: number,
):
  | "roomMap:inspector.hueHeightFloor"
  | "roomMap:inspector.hueHeightEye"
  | "roomMap:inspector.hueHeightCeiling" {
  if (worldZ <= -0.34) return "roomMap:inspector.hueHeightFloor";
  if (worldZ >= 0.34) return "roomMap:inspector.hueHeightCeiling";
  return "roomMap:inspector.hueHeightEye";
}

export function HueChannelInspector({
  channel,
  zoneName,
  bridgeStatus = "unknown",
  world,
  worldZ,
  heightRange,
  roomWidthMeters,
  roomDepthMeters,
  roomHeightMeters,
  onMove,
  onHeightChange,
  lightCount,
  isGhost = false,
  onRename,
  onToggleLock,
}: {
  channel: HueChannelPlacement;
  zoneName: string | null;
  /** Resolved position in the cube — a zone-bound channel's live value is zone-relative. */
  world: { x: number; y: number };
  /** Resolved height — a zone-bound channel's live value is zone-relative. */
  worldZ: number;
  /** Heights the channel can reach; a bound zone narrows it. Default [-1, 1]. */
  heightRange?: { min: number; max: number; zone: HueZone | null };
  roomWidthMeters: number;
  roomDepthMeters: number;
  roomHeightMeters: number;
  /** A new position in the cube; the editor writes whichever field is live. */
  onMove: (worldX: number, worldY: number) => void;
  onHeightChange: (worldZ: number) => void;
  /**
   * Hue bridge reachability mirror. Renders the same
   * connection chip vocabulary used by `UsbStripInspector` so a
   * disconnected Hue bridge is as visible as a disconnected USB port.
   * `unknown` (default) ⇒ no chip rendered.
   */
  bridgeStatus?: UsbStripConnectionStatus;
  /** How many bulbs this channel drives, from the bridge. `null` when the
   *  channel is not in the area the bridge reports — see `isGhost`. */
  lightCount?: number | null;
  /** True when the bridge no longer reports this channel. Distinct from an
   *  unresolved placement, which was never matched to one at all. */
  isGhost?: boolean;
  onRename: (label: string) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!channel.locked;
  const [labelDraft, setLabelDraft] = useState(
    hueChannelName(channel, t),
  );
  const [labelDirty, setLabelDirty] = useState(false);

  if (!labelDirty) {
    const external = hueChannelName(channel, t);
    if (external !== labelDraft) setLabelDraft(external);
  }

  const minZ = heightRange?.min ?? -1;
  const maxZ = heightRange?.max ?? 1;
  const limitingZone = heightRange?.zone && (minZ > -1 || maxZ < 1) ? heightRange.zone : null;
  const shownZ = Math.min(maxZ, Math.max(minZ, worldZ));
  /** Slider stays in Hue's [-1, 1]; only the readout is metres, because that is
   *  the unit the rest of the map speaks and `-0.42` names nothing a person owns. */
  const heightMetres = (z: number) => hueToMetres(z, roomHeightMeters).toFixed(2);
  // Metres on the plan, as every other object's position reads; the cube's [-1, 1] stays inside.
  const plan = hueToPlanMetres(world, roomWidthMeters, roomDepthMeters);
  const moveTo = (x: number, y: number) => {
    const next = planMetresToHue(x, y, roomWidthMeters, roomDepthMeters);
    onMove(next.x, next.y);
  };

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(hueChannelName(channel, t));
      return;
    }
    if (trimmed !== channel.label) onRename(trimmed);
  };

  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeHue")}
        name={hueChannelName(channel, t)}
        dotColor={TYPE_DOT_COLOR.hue}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`hue-label-${channel.channelIndex}`}>
          {t("roomMap:inspector.furnitureNameLabel")}
        </label>
        <input
          id={`hue-label-${channel.channelIndex}`}
          type="text"
          className="lm-room-dock-input"
          value={labelDraft}
          disabled={locked}
          onChange={(e) => {
            setLabelDirty(true);
            setLabelDraft(e.target.value);
          }}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitLabel();
            } else if (e.key === "Escape") {
              setLabelDraft(hueChannelName(channel, t));
              setLabelDirty(false);
            }
          }}
        />
      </div>
      {bridgeStatus !== "unknown" ? (
        <div className="lm-room-dock-field">
          <span className="lm-room-dock-field-label">
            {t("roomMap:inspector.hueBridgeLabel")}
          </span>
          <span
            className={`lm-room-dock-conn-chip lm-room-dock-conn-chip--${bridgeStatus}`}
            role="status"
            aria-live="polite"
          >
            <span className="lm-room-dock-conn-chip-dot" aria-hidden />
            <span className="lm-room-dock-conn-chip-tx">
              {bridgeStatus === "connected"
                ? t("roomMap:inspector.hueBridgeConnected")
                : t("roomMap:inspector.hueBridgeDisconnected")}
            </span>
          </span>
        </div>
      ) : null}
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap:inspector.hueChannelIndexLabel")}
        </span>
        <span className="lm-room-dock-field-value">
          {hueChannelIdLabel(channel.channelId) ?? t("roomMap:inspector.hueChannelUnresolved")}
        </span>
      </div>
      {lightCount != null && (
        <div className="lm-room-dock-field">
          <span className="lm-room-dock-field-label">
            {t("roomMap:inspector.hueLightCountLabel")}
          </span>
          <span className="lm-room-dock-field-value">
            {lightCount === 1
              ? t("roomMap:inspector.hueOneLight")
              : t("roomMap:inspector.hueLights", { count: lightCount })}
          </span>
        </div>
      )}
      {isGhost && (
        <p className="lm-room-dock-note" role="status">
          {t("roomMap:inspector.hueChannelGhostNote")}
        </p>
      )}
      <FieldPair>
        <DecimalField
          label={t("roomMap:inspector.xLabel")}
          prefix="X"
          value={plan.x}
          min={0}
          max={roomWidthMeters}
          unit="m"
          disabled={locked}
          onCommit={(x) => moveTo(x, plan.y)}
        />
        <DecimalField
          label={t("roomMap:inspector.yLabel")}
          prefix="Y"
          value={plan.y}
          min={0}
          max={roomDepthMeters}
          unit="m"
          disabled={locked}
          onCommit={(y) => moveTo(plan.x, y)}
        />
      </FieldPair>
      <RangeRow
        variant="dock"
        className="lm-zone-inspector-slider-row"
        label={t("roomMap:inspector.hueHeightLabel")}
        ariaLabel={t("roomMap:inspector.hueHeightAriaLabel")}
        min={minZ}
        max={maxZ}
        step={0.01}
        value={shownZ}
        disabled={locked || maxZ <= minZ}
        onChange={onHeightChange}
        // The raw -1..1 is meaningless read aloud; this is the whole reason the
        // control moved off the Devices strip, so do not drop it.
        ariaValueText={t("roomMap:inspector.hueHeightValueText", {
          metres: heightMetres(shownZ),
          label: t(heightBandKey(shownZ)),
        })}
        valueLabel={t("roomMap:inspector.hueHeightReadout", {
          metres: heightMetres(shownZ),
        })}
      />
      {limitingZone && (
        <p className="lm-room-dock-field-hint" data-testid="hue-height-zone-limit">
          {t("roomMap:inspector.hueHeightZoneLimit", {
            name: limitingZone.name,
            min: heightMetres(minZ),
            max: heightMetres(maxZ),
          })}
        </p>
      )}
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap:inspector.hueZoneLabel")}
        </span>
        <span className="lm-room-dock-field-value">
          {zoneName ?? t("roomMap:hueZones.unassignedTitle")}
        </span>
      </div>
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap:inspector.hueChannelHint")}</p>
    </>
  );
}
