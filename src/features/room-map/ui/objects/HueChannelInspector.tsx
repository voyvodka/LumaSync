import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import type { UsbStripConnectionStatus } from "./UsbStripInspector";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

export function HueChannelInspector({
  channel,
  zoneName,
  bridgeStatus = "unknown",
  onRename,
  onToggleLock,
}: {
  channel: HueChannelPlacement;
  zoneName: string | null;
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
