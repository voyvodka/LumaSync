import { useEffect, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { IconDragHandle, IconMoveTo } from "@/shared/ui/icons";
import { MovePopover } from "./MovePopover";
import { getZoneColor } from "../model/zoneColor";
import { deriveHueAreaState } from "../model/hueAreaState";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";

interface HueZonesTabProps {
  hueZones: HueZone[];
  channels: HueChannelPlacement[];
  activeHueZoneId: string | null;
  onSelectHueZone: (id: string | null) => void;
  onAddHueZone: () => void;
  onDeleteHueZone: (id: string) => void;
  onRenameHueZone: (id: string, name: string) => void;
  addHueZoneDisabled: boolean;
  addHueZoneDisabledTooltip?: string;
  onSelectChannel: (idx: number) => void;
  hueBridgeConfigured: boolean;
  hueAreaId: string | null;
  onAssignChannelToZone?: (channelIndex: number, targetZoneId: string | null) => void;
  onNavigateToDevices?: () => void;
  /** Re-read the bridge's channel list. Absent ⇒ the surface has no bridge client. */
  onRefreshChannels?: () => void;
  isRefreshingChannels?: boolean;
  /** Last channel-fetch code. A failed read must not look like an empty area. */
  channelsStatus?: string | null;
}

export function HueZonesTab(props: HueZonesTabProps) {
  const {
    hueZones,
    channels,
    activeHueZoneId,
    onSelectHueZone,
    onAddHueZone,
    onDeleteHueZone,
    onRenameHueZone,
    addHueZoneDisabled,
    addHueZoneDisabledTooltip,
    onSelectChannel,
    hueBridgeConfigured,
    hueAreaId,
    onAssignChannelToZone,
    onNavigateToDevices,
    onRefreshChannels,
    isRefreshingChannels = false,
    channelsStatus,
  } = props;
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // ── Wave 4-B (B1) — area-state header ─────────────────────────────
  const areaState = deriveHueAreaState(hueBridgeConfigured, hueAreaId);
  // EMPTY is a clean answer — the area really has no lights — so only the
  // genuinely unread codes may claim the screen is showing stale data.
  const channelsEmpty = channelsStatus === HUE_AREA_CHANNELS_STATUS.EMPTY;
  const channelsUnread =
    channelsStatus != null && channelsStatus !== HUE_AREA_CHANNELS_STATUS.OK && !channelsEmpty;

  // ── Wave 4-B (B2/B3) — drag-and-drop + move popover state ─────────
  const [dragChannelIndex, setDragChannelIndex] = useState<number | null>(null);
  const [dropTargetZoneId, setDropTargetZoneId] = useState<string | null | undefined>(undefined);
  const [movePopover, setMovePopover] = useState<{
    channelIndex: number;
    triggerRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    if (dragChannelIndex !== null && !channels.some((c) => c.channelIndex === dragChannelIndex)) {
      setDragChannelIndex(null);
      setDropTargetZoneId(undefined);
    }
  }, [channels, dragChannelIndex]);

  const byZone = new Map<string, HueChannelPlacement[]>();
  const unassigned: HueChannelPlacement[] = [];
  for (const ch of channels) {
    if (ch.zoneId && hueZones.some((z) => z.id === ch.zoneId)) {
      const bucket = byZone.get(ch.zoneId) ?? [];
      bucket.push(ch);
      byZone.set(ch.zoneId, bucket);
    } else {
      unassigned.push(ch);
    }
  }

  const dragSupported = !!onAssignChannelToZone;

  // The index goes into `text/plain` as well as the custom MIME, and
  // `onDragEnter` must `preventDefault()` too — WKWebView strips the custom type
  // and the drop dies without either. See docs/architecture/room-map.md.
  const CHANNEL_MIME = "application/x-lumasync-channel";

  const channelDragProps = (ch: HueChannelPlacement) => {
    if (!dragSupported) return {} as Record<string, never>;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLLIElement>) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        const payload = String(ch.channelIndex);
        // Best-effort write under both MIME types so WKWebView always
        // has a `text/plain` reader path. Some browsers throw on
        // unknown MIME — guard so we never abort the drag.
        try {
          e.dataTransfer.setData(CHANNEL_MIME, payload);
        } catch (err) {
          console.error("[LumaSync] DnD setData(custom MIME) failed", err);
        }
        e.dataTransfer.setData("text/plain", payload);
        setDragChannelIndex(ch.channelIndex);
      },
      onDragEnd: () => {
        setDragChannelIndex(null);
        setDropTargetZoneId(undefined);
      },
    } as const;
  };

  const dropTargetProps = (targetZoneId: string | null) => {
    if (!dragSupported) return {} as Record<string, never>;
    return {
      onDragEnter: (e: React.DragEvent) => {
        if (dragChannelIndex === null) return;
        e.preventDefault();
        if (dropTargetZoneId !== targetZoneId) setDropTargetZoneId(targetZoneId);
      },
      onDragOver: (e: React.DragEvent) => {
        if (dragChannelIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropTargetZoneId !== targetZoneId) setDropTargetZoneId(targetZoneId);
      },
      onDragLeave: () => {
        if (dropTargetZoneId === targetZoneId) setDropTargetZoneId(undefined);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        // Try the custom MIME first (preserves intent) then fall back
        // to text/plain. If both come back empty, use the in-memory
        // index so a WebKit-stripped payload still resolves.
        let raw = e.dataTransfer.getData(CHANNEL_MIME);
        if (!raw) raw = e.dataTransfer.getData("text/plain");
        const parsed = raw ? parseInt(raw, 10) : NaN;
        const idx = Number.isFinite(parsed) ? parsed : dragChannelIndex;
        if (idx === null || Number.isNaN(idx)) return;
        onAssignChannelToZone?.(idx, targetZoneId);
        setDragChannelIndex(null);
        setDropTargetZoneId(undefined);
      },
    } as const;
  };

  return (
    <>
      {/* B1 — Hue area state strip; renders above the Title row so the
          user always knows whether the dock is operational without
          cross-referencing the Devices section. */}
      <div
        className={`lm-room-dock-area-state lm-room-dock-area-state--${areaState.kind}`}
        role="status"
        aria-live="polite"
      >
        <span className="lm-room-dock-area-state-dot" aria-hidden />
        <div className="lm-room-dock-area-state-text">
          <span className="lm-room-dock-area-state-title">
            {areaState.kind === "not-configured"
              ? areaState.orphanedAreaId
                ? t("roomMap:hueZones.areaState.offlineTitle")
                : t("roomMap:hueZones.areaState.notConfiguredTitle")
              : areaState.kind === "no-area"
                ? t("roomMap:hueZones.areaState.noAreaTitle")
                : t("roomMap:hueZones.areaState.readyTitle", {
                    N: String(hueZones.length),
                  })}
          </span>
          <span className="lm-room-dock-area-state-sub">
            {areaState.kind === "not-configured"
              ? areaState.orphanedAreaId
                ? t("roomMap:hueZones.areaState.offlineHint")
                : t("roomMap:hueZones.areaState.notConfiguredHint")
              : areaState.kind === "no-area"
                ? t("roomMap:hueZones.areaState.noAreaHint")
                : channelsUnread
                  ? t("roomMap:hueZones.areaState.unreadHint")
                  : channelsEmpty
                    ? t("roomMap:hueZones.areaState.emptyHint")
                    : t("roomMap:hueZones.areaState.readyHint")}
          </span>
        </div>
        {areaState.kind === "ready" && onRefreshChannels && (
          <button
            type="button"
            className="lm-room-dock-area-state-cta"
            onClick={onRefreshChannels}
            disabled={isRefreshingChannels}
            title={t("roomMap:hueZones.areaState.refreshTitle")}
          >
            {isRefreshingChannels
              ? t("roomMap:hueZones.areaState.refreshing")
              : t("roomMap:hueZones.areaState.refresh")}
          </button>
        )}
        {areaState.kind !== "ready" && onNavigateToDevices && (
          <button
            type="button"
            className="lm-room-dock-area-state-cta"
            onClick={onNavigateToDevices}
          >
            {areaState.kind === "not-configured"
              ? t("roomMap:hueZones.areaState.notConfiguredCta")
              : t("roomMap:hueZones.areaState.noAreaCta")}
          </button>
        )}
      </div>

      <div className="lm-room-dock-h">
        <span className="lm-room-dock-h-name">{t("roomMap:hueZones.title")}</span>
        <button
          type="button"
          className="lm-room-dock-h-add"
          onClick={addHueZoneDisabled ? undefined : onAddHueZone}
          aria-disabled={addHueZoneDisabled}
          title={addHueZoneDisabled ? addHueZoneDisabledTooltip : undefined}
        >
          {t("roomMap:hueZones.addAction")}
        </button>
      </div>

      {hueZones.length === 0 ? (
        <div className="lm-room-dock-empty">
          <div>{t("roomMap:hueZones.empty")}</div>
          <button
            type="button"
            className="lm-room-dock-cta lm-room-dock-empty-cta"
            onClick={addHueZoneDisabled ? undefined : onAddHueZone}
            aria-disabled={addHueZoneDisabled}
            title={addHueZoneDisabled ? addHueZoneDisabledTooltip : undefined}
          >
            {t("roomMap:hueZones.emptyCta")}
          </button>
        </div>
      ) : (
        <ul className="space-y-px">
          {hueZones.map((zone, zi) => {
            const isActive = activeHueZoneId === zone.id;
            const isEditing = editingId === zone.id;
            const color = getZoneColor(zone, zi);
            const bucket = byZone.get(zone.id) ?? [];
            const isDropTarget = dropTargetZoneId === zone.id && dragChannelIndex !== null;
            return (
              <li key={zone.id}>
                <div
                  className={[
                    "lm-room-dock-row",
                    isActive ? "is-on" : "",
                    isDropTarget ? "is-drop-target" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                  data-drop-zone-id={zone.id}
                  onClick={() => onSelectHueZone(isActive ? null : zone.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectHueZone(isActive ? null : zone.id);
                    }
                  }}
                  {...dropTargetProps(zone.id)}
                >
                  <span
                    className="lm-room-dock-row-dot"
                    style={{ background: color }}
                    aria-hidden
                  />
                  {isEditing ? (
                    <input
                      autoFocus
                      className="lm-room-dock-row-edit"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => {
                        const fallback = t("roomMap:hueZones.defaultName", { N: String(zi + 1) });
                        const name = editValue.trim() || fallback;
                        onRenameHueZone(zone.id, name);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const fallback = t("roomMap:hueZones.defaultName", { N: String(zi + 1) });
                          const name = editValue.trim() || fallback;
                          onRenameHueZone(zone.id, name);
                          setEditingId(null);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="lm-room-dock-row-label"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(zone.id);
                        setEditValue(zone.name);
                      }}
                    >
                      {zone.name}
                    </span>
                  )}
                  <span className="lm-room-dock-row-meta">
                    {bucket.length === 1
                      ? t("roomMap:hueZones.lightCountOne")
                      : t("roomMap:hueZones.lightCount", { N: String(bucket.length) })}
                  </span>
                  <button
                    type="button"
                    className="lm-room-dock-row-action is-danger"
                    aria-label={t("roomMap:hueZones.deleteAriaLabel", { name: zone.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteHueZone(zone.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {bucket.length > 0 && (
                  <ul className="space-y-px">
                    {bucket.map((ch) => (
                      <li
                        key={ch.channelIndex}
                        className={[
                          "lm-room-dock-row",
                          "is-nested",
                          dragChannelIndex === ch.channelIndex ? "is-drag-source" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectChannel(ch.channelIndex);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectChannel(ch.channelIndex);
                          }
                        }}
                        {...channelDragProps(ch)}
                      >
                        {dragSupported && (
                          <span
                            className="lm-room-dock-row-grip"
                            aria-hidden
                            title={t("roomMap:hueZones.dragHandleTip")}
                          >
                            <IconDragHandle />
                          </span>
                        )}
                        <span
                          className="lm-room-dock-row-dot"
                          style={{ background: color, opacity: 0.7 }}
                          aria-hidden
                        />
                        <span className="lm-room-dock-row-label">
                          {ch.label ??
                            t("roomMap:hueChannel.defaultLabel", {
                              index: String(ch.channelIndex + 1),
                            })}
                        </span>
                        {dragSupported && (
                          <button
                            type="button"
                            className="lm-room-dock-row-action lm-room-dock-row-action--move"
                            aria-label={t("roomMap:hueZones.moveChannelAriaLabel", {
                              channel: String(ch.channelIndex + 1),
                            })}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                              setMovePopover({ channelIndex: ch.channelIndex, triggerRect: rect });
                            }}
                          >
                            <IconMoveTo />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {(unassigned.length > 0 || dragSupported) && (
            <li>
              <div
                className={[
                  "lm-room-dock-h",
                  dropTargetZoneId === null && dragChannelIndex !== null ? "is-drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="heading"
                aria-level={3}
                data-drop-zone-id="__unassigned__"
                {...dropTargetProps(null)}
              >
                <span
                  className="lm-room-dock-h-dot"
                  style={{ background: "var(--lm-ink-faint)" }}
                  aria-hidden
                />
                <span className="lm-room-dock-h-name">
                  {t("roomMap:hueZones.unassignedTitle")}
                </span>
                <span className="lm-room-dock-h-count">{unassigned.length}</span>
              </div>
              {unassigned.length > 0 && (
                <ul className="space-y-px">
                  {unassigned.map((ch) => (
                    <li
                      key={ch.channelIndex}
                      className={[
                        "lm-room-dock-row",
                        "is-nested",
                        dragChannelIndex === ch.channelIndex ? "is-drag-source" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectChannel(ch.channelIndex)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectChannel(ch.channelIndex);
                        }
                      }}
                      {...channelDragProps(ch)}
                    >
                      {dragSupported && (
                        <span
                          className="lm-room-dock-row-grip"
                          aria-hidden
                          title={t("roomMap:hueZones.dragHandleTip")}
                        >
                          <IconDragHandle />
                        </span>
                      )}
                      <span
                        className="lm-room-dock-row-dot"
                        style={{ background: "var(--lm-ink-faint)", opacity: 0.7 }}
                        aria-hidden
                      />
                      <span className="lm-room-dock-row-label">
                        {ch.label ??
                          t("roomMap:hueChannel.defaultLabel", {
                            index: String(ch.channelIndex + 1),
                          })}
                      </span>
                      {dragSupported && hueZones.length > 0 && (
                        <button
                          type="button"
                          className="lm-room-dock-row-action lm-room-dock-row-action--move"
                          aria-label={t("roomMap:hueZones.moveChannelAriaLabel", {
                            channel: String(ch.channelIndex + 1),
                          })}
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                            setMovePopover({ channelIndex: ch.channelIndex, triggerRect: rect });
                          }}
                        >
                          <IconMoveTo />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}

      {movePopover && onAssignChannelToZone && (
        <MovePopover
          zones={hueZones}
          currentZoneId={
            channels.find((c) => c.channelIndex === movePopover.channelIndex)?.zoneId ?? null
          }
          triggerRect={movePopover.triggerRect}
          onPick={(zoneId) => onAssignChannelToZone(movePopover.channelIndex, zoneId)}
          onClose={() => setMovePopover(null)}
        />
      )}
    </>
  );
}
