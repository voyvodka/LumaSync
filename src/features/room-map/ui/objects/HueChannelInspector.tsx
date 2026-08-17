import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import type { UsbStripConnectionStatus } from "./UsbStripInspector";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

/** Slider stays in Hue's [-1, 1]; only the readout is metres, because that is
 *  the unit the rest of the map speaks and `-0.42` names nothing a person owns. */
function heightMetres(worldZ: number, roomHeightMeters: number): number {
  return ((worldZ + 1) / 2) * roomHeightMeters;
}

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
  worldZ,
  roomHeightMeters,
  onHeightChange,
  onRename,
  onToggleLock,
}: {
  channel: HueChannelPlacement;
  zoneName: string | null;
  /** Resolved height — a zone-bound channel's live value is zone-relative. */
  worldZ: number;
  roomHeightMeters: number;
  onHeightChange: (worldZ: number) => void;
  /**
   * Wave 4-G #4 — Hue bridge reachability mirror. Renders the same
   * connection chip vocabulary used by `UsbStripInspector` so a
   * disconnected Hue bridge is as visible as a disconnected USB port.
   * `unknown` (default) ⇒ no chip rendered.
   */
  bridgeStatus?: UsbStripConnectionStatus;
  onRename: (label: string) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!channel.locked;
  const [labelDraft, setLabelDraft] = useState(
    channel.label ?? t("roomMap:hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
  );
  const [labelDirty, setLabelDirty] = useState(false);

  if (!labelDirty) {
    const external =
      channel.label ?? t("roomMap:hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) });
    if (external !== labelDraft) setLabelDraft(external);
  }

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(
        channel.label ?? t("roomMap:hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
      );
      return;
    }
    if (trimmed !== channel.label) onRename(trimmed);
  };

  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeHue")}
        name={
          channel.label ??
          t("roomMap:hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) })
        }
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
              setLabelDraft(
                channel.label ??
                  t("roomMap:hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
              );
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
        <span className="lm-room-dock-field-value">{channel.channelIndex + 1}</span>
      </div>
      <div className="lm-room-dock-field lm-zone-inspector-slider-row">
        <label className="lm-room-dock-field-label" htmlFor={`hue-height-${channel.channelIndex}`}>
          {t("roomMap:inspector.hueHeightLabel")}
        </label>
        <input
          id={`hue-height-${channel.channelIndex}`}
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={worldZ}
          disabled={locked}
          onChange={(e) => { onHeightChange(parseFloat(e.target.value)); }}
          className="lm-room-dock-slider"
          aria-label={t("roomMap:inspector.hueHeightAriaLabel")}
          aria-valuemin={-1}
          aria-valuemax={1}
          aria-valuenow={worldZ}
          // The raw -1..1 is meaningless read aloud; this is the whole reason the
          // control moved off the Devices strip, so do not drop it.
          aria-valuetext={t("roomMap:inspector.hueHeightValueText", {
            metres: heightMetres(worldZ, roomHeightMeters).toFixed(2),
            label: t(heightBandKey(worldZ)),
          })}
        />
        <span className="lm-room-dock-field-value">
          {t("roomMap:inspector.hueHeightReadout", {
            metres: heightMetres(worldZ, roomHeightMeters).toFixed(2),
          })}
        </span>
      </div>
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
