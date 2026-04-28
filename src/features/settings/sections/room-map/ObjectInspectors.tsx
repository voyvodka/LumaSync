/**
 * ObjectInspectors — type-aware inspector components rendered inside
 * `RoomDockPanel` when an object (or legacy zone) is the active selection.
 *
 * Why this file exists (Wave 4-D rework):
 * --------------------------------------
 * Before W4-D the dock had four tabs (Objects / Zones / Hue Zones /
 * **Properties**) and the Properties tab simply rendered an empty
 * "pick something" hint — the tab itself never carried unique content
 * because the same inspector was already mounted in the bottom half of
 * the dock body (split-pane layout). The user feedback ("prop tabı ne
 * yapıyor anlamadım gereksiz gibi") confirmed the redundancy.
 *
 * Resolution: the Properties tab is dropped, and the inspector below
 * the tab list now swaps **type-specific** components based on what is
 * selected. Each inspector surfaces the controls that matter for its
 * type — instead of every selection routing the user to the generic
 * X/Y/W/H/R PropertyBar at the bottom of the editor.
 *
 * Inspectors implemented here:
 *   - `FurnitureInspector`     — name (rename), type, rotation, lock
 *   - `TvAnchorInspector`      — physical width/height in metres, lock
 *   - `UsbStripInspector`      — LED count, linked port + connection
 *                                status badge (Wave 4-E surface), lock,
 *                                "Disconnect" affordance
 *   - `HueChannelInspector`    — channel index, parent zone, label,
 *                                world coords (read-only summary)
 *   - `ImageLayerInspector`    — opacity slider + reset
 *   - `LegacyZoneInspector`    — channel count + assign hint
 *
 * `HueZoneInspector` lives in its own file (W4-C surface, untouched).
 *
 * Composition rules:
 * ------------------
 * - Every inspector sits inside the existing `lm-room-dock-inspect`
 *   container — it does not own the outer chrome. Each renders an
 *   `lm-room-dock-inspect-h` header (chip + name) and a stack of
 *   `lm-room-dock-field` rows.
 * - Tap targets ≥ 32 px (slider thumbs already 12 px, but interactive
 *   buttons clear the floor via `min-height: 32px`).
 * - Reduced-motion + forced-colors fall back to the inherited dock
 *   styles in `styles.css`; no new transitions defined here.
 * - 100 % localised — every visible string goes through `t()`.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZone,
  ImageLayer,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "../../../../shared/contracts/roomMap";

/* ── shared helpers ─────────────────────────────────────────────── */

const TYPE_DOT_COLOR = {
  tv: "var(--lm-zone-3)",
  furniture: "var(--lm-amber)",
  usb: "var(--lm-zone-6)",
  hue: "var(--lm-ink-dim)",
  image: "var(--lm-ink-faint)",
} as const;

const FURNITURE_TYPES: FurniturePlacement["type"][] = ["sofa", "table", "chair", "other"];

/**
 * Inline number input shared by all inspectors. Behaves like the
 * PropertyBar's `NumberInput` (commit on blur / Enter, reverts on
 * invalid parse) but visually tuned for the dock — denser typography,
 * mono caps label aligned with `lm-room-dock-field-label`.
 */
function InspectorNumberField({
  id,
  label,
  value,
  step = 0.1,
  min,
  max,
  unit,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [local, setLocal] = useState(value.toFixed(step >= 1 ? 0 : 2));
  const [editing, setEditing] = useState(false);

  if (!editing && local !== value.toFixed(step >= 1 ? 0 : 2)) {
    // Sync external updates while not actively editing — same pattern
    // PropertyBar uses to avoid clobbering an in-flight typed value.
    setLocal(value.toFixed(step >= 1 ? 0 : 2));
  }

  const commit = useCallback(() => {
    setEditing(false);
    const num = parseFloat(local);
    if (Number.isNaN(num)) {
      setLocal(value.toFixed(step >= 1 ? 0 : 2));
      return;
    }
    let clamped = num;
    if (typeof min === "number") clamped = Math.max(min, clamped);
    if (typeof max === "number") clamped = Math.min(max, clamped);
    onCommit(clamped);
  }, [local, max, min, onCommit, step, value]);

  return (
    <div className="lm-room-dock-field">
      <label className="lm-room-dock-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        className="lm-room-dock-input"
        value={local}
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setLocal(value.toFixed(step >= 1 ? 0 : 2));
            setEditing(false);
          }
        }}
      />
      {unit ? <span className="lm-room-dock-field-unit">{unit}</span> : null}
    </div>
  );
}

/**
 * `Header` is shared by every inspector so the visual rhythm matches
 * `HueZoneInspector` (the W4-C reference). The chip label is the
 * machine-readable type (translated) and `name` is the user-facing
 * label of the selected object.
 */
function Header({
  typeLabel,
  name,
  dotColor,
}: {
  typeLabel: string;
  name: string;
  dotColor: string;
}) {
  return (
    <div className="lm-room-dock-inspect-h">
      <span className="lm-room-dock-inspect-h-chip">
        <span
          className="lm-room-dock-inspect-h-chip-dot"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span>{typeLabel}</span>
      </span>
      <span className="sub" title={name}>
        {name}
      </span>
    </div>
  );
}

/* ── TvAnchorInspector ──────────────────────────────────────────── */

export function TvAnchorInspector({
  tv,
  onUpdate,
  onToggleLock,
}: {
  tv: TvAnchorPlacement;
  onUpdate: (patch: Partial<TvAnchorPlacement>) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation("common");
  const locked = !!tv.locked;
  return (
    <>
      <Header
        typeLabel={t("roomMap.inspector.typeTv")}
        name={t("roomMap.objectPanel.tvLabel")}
        dotColor={TYPE_DOT_COLOR.tv}
      />
      <InspectorNumberField
        id="tv-w"
        label={t("roomMap.inspector.widthLabel")}
        value={tv.width}
        step={0.05}
        min={0.05}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ width: next })}
      />
      <InspectorNumberField
        id="tv-h"
        label={t("roomMap.inspector.heightLabel")}
        value={tv.height}
        step={0.05}
        min={0.02}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ height: next })}
      />
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap.inspector.tvHint")}</p>
    </>
  );
}

/* ── FurnitureInspector ─────────────────────────────────────────── */

export function FurnitureInspector({
  item,
  onUpdate,
  onToggleLock,
  onRename,
}: {
  item: FurniturePlacement;
  onUpdate: (patch: Partial<FurniturePlacement>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
}) {
  const { t } = useTranslation("common");
  const locked = !!item.locked;
  const [labelDraft, setLabelDraft] = useState(item.label ?? t(`roomMap.furniture.type.${item.type}`));
  const [labelDirty, setLabelDirty] = useState(false);

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(item.label ?? t(`roomMap.furniture.type.${item.type}`));
      return;
    }
    if (trimmed !== item.label) onRename(trimmed);
  };

  // Sync external rename while not editing.
  if (!labelDirty) {
    const external = item.label ?? t(`roomMap.furniture.type.${item.type}`);
    if (external !== labelDraft) setLabelDraft(external);
  }

  return (
    <>
      <Header
        typeLabel={t("roomMap.inspector.typeFurniture")}
        name={item.label ?? t(`roomMap.furniture.type.${item.type}`)}
        dotColor={TYPE_DOT_COLOR.furniture}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`furn-name-${item.id}`}>
          {t("roomMap.inspector.furnitureNameLabel")}
        </label>
        <input
          id={`furn-name-${item.id}`}
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
              setLabelDraft(item.label ?? t(`roomMap.furniture.type.${item.type}`));
              setLabelDirty(false);
            }
          }}
        />
      </div>

      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`furn-type-${item.id}`}>
          {t("roomMap.inspector.furnitureTypeLabel")}
        </label>
        <select
          id={`furn-type-${item.id}`}
          className="lm-room-dock-select"
          value={item.type}
          disabled={locked}
          onChange={(e) => onUpdate({ type: e.target.value as FurniturePlacement["type"] })}
        >
          {FURNITURE_TYPES.map((tp) => (
            <option key={tp} value={tp}>
              {t(`roomMap.furniture.type.${tp}`)}
            </option>
          ))}
        </select>
      </div>

      <InspectorNumberField
        id={`furn-w-${item.id}`}
        label={t("roomMap.inspector.widthLabel")}
        value={item.width}
        step={0.05}
        min={0.1}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ width: next })}
      />
      <InspectorNumberField
        id={`furn-h-${item.id}`}
        label={t("roomMap.inspector.heightLabel")}
        value={item.height}
        step={0.05}
        min={0.1}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ height: next })}
      />
      <InspectorNumberField
        id={`furn-r-${item.id}`}
        label={t("roomMap.inspector.furnitureRotationLabel")}
        value={item.rotation ?? 0}
        step={1}
        min={0}
        max={359}
        unit="°"
        disabled={locked}
        onCommit={(next) => onUpdate({ rotation: ((next % 360) + 360) % 360 })}
      />

      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
      </button>
    </>
  );
}

/* ── UsbStripInspector ──────────────────────────────────────────── */

/**
 * Connection status the inspector renders next to the LED count.
 * `unknown` ⇒ no port snapshot has loaded yet (initial mount race).
 * `connected` / `disconnected` come from `useUsbConnectionStatus`.
 */
export type UsbStripConnectionStatus = "connected" | "disconnected" | "unknown";

export function UsbStripInspector({
  strip,
  connectionStatus,
  connectedPort,
  onUpdate,
  onToggleLock,
  onManage,
}: {
  strip: UsbStripPlacement;
  connectionStatus: UsbStripConnectionStatus;
  connectedPort: string | null;
  onUpdate: (patch: Partial<UsbStripPlacement>) => void;
  onToggleLock: () => void;
  onManage?: () => void;
}) {
  const { t } = useTranslation("common");
  const locked = !!strip.locked;

  return (
    <>
      <Header
        typeLabel={t("roomMap.inspector.typeUsb")}
        name={t("roomMap.objectPanel.ledLabel", { count: String(strip.ledCount) })}
        dotColor={TYPE_DOT_COLOR.usb}
      />

      {/* Linked port + live status badge */}
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap.inspector.usbPortLabel")}
        </span>
        <span
          className={`lm-room-dock-conn-chip lm-room-dock-conn-chip--${connectionStatus}`}
          role="status"
          aria-live="polite"
        >
          <span className="lm-room-dock-conn-chip-dot" aria-hidden />
          <span className="lm-room-dock-conn-chip-tx">
            {connectionStatus === "connected"
              ? (connectedPort ?? t("roomMap.inspector.usbConnectedFallback"))
              : connectionStatus === "disconnected"
                ? t("roomMap.inspector.usbConnectionDisconnected")
                : t("roomMap.inspector.usbConnectionUnknown")}
          </span>
        </span>
      </div>

      <InspectorNumberField
        id={`usb-leds-${strip.stripId}`}
        label={t("roomMap.inspector.usbLedCountLabel")}
        value={strip.ledCount}
        step={1}
        min={1}
        max={1000}
        disabled={locked}
        onCommit={(next) => onUpdate({ ledCount: Math.round(next) })}
      />

      <div className="lm-room-dock-field-actions">
        <button
          type="button"
          className="lm-room-dock-inspect-action"
          onClick={onToggleLock}
          aria-pressed={locked}
        >
          {locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
        </button>
        {onManage ? (
          <button
            type="button"
            className="lm-room-dock-inspect-action"
            onClick={onManage}
          >
            {t("roomMap.inspector.usbManage")}
          </button>
        ) : null}
      </div>

      <p className="lm-room-dock-field-hint">{t("roomMap.inspector.usbHint")}</p>
    </>
  );
}

/* ── HueChannelInspector ────────────────────────────────────────── */

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
  const { t } = useTranslation("common");
  const locked = !!channel.locked;
  const [labelDraft, setLabelDraft] = useState(
    channel.label ?? t("roomMap.hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
  );
  const [labelDirty, setLabelDirty] = useState(false);

  if (!labelDirty) {
    const external =
      channel.label ?? t("roomMap.hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) });
    if (external !== labelDraft) setLabelDraft(external);
  }

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(
        channel.label ?? t("roomMap.hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
      );
      return;
    }
    if (trimmed !== channel.label) onRename(trimmed);
  };

  return (
    <>
      <Header
        typeLabel={t("roomMap.inspector.typeHue")}
        name={
          channel.label ??
          t("roomMap.hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) })
        }
        dotColor={TYPE_DOT_COLOR.hue}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`hue-label-${channel.channelIndex}`}>
          {t("roomMap.inspector.furnitureNameLabel")}
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
                  t("roomMap.hueChannel.defaultLabel", { index: String(channel.channelIndex + 1) }),
              );
              setLabelDirty(false);
            }
          }}
        />
      </div>
      {bridgeStatus !== "unknown" ? (
        <div className="lm-room-dock-field">
          <span className="lm-room-dock-field-label">
            {t("roomMap.inspector.hueBridgeLabel")}
          </span>
          <span
            className={`lm-room-dock-conn-chip lm-room-dock-conn-chip--${bridgeStatus}`}
            role="status"
            aria-live="polite"
          >
            <span className="lm-room-dock-conn-chip-dot" aria-hidden />
            <span className="lm-room-dock-conn-chip-tx">
              {bridgeStatus === "connected"
                ? t("roomMap.inspector.hueBridgeConnected")
                : t("roomMap.inspector.hueBridgeDisconnected")}
            </span>
          </span>
        </div>
      ) : null}
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap.inspector.hueChannelIndexLabel")}
        </span>
        <span className="lm-room-dock-field-value">{channel.channelIndex + 1}</span>
      </div>
      <div className="lm-room-dock-field">
        <span className="lm-room-dock-field-label">
          {t("roomMap.inspector.hueZoneLabel")}
        </span>
        <span className="lm-room-dock-field-value">
          {zoneName ?? t("roomMap.hueZones.unassignedTitle")}
        </span>
      </div>
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap.inspector.hueChannelHint")}</p>
    </>
  );
}

/* ── ImageLayerInspector ────────────────────────────────────────── */

export function ImageLayerInspector({
  layer,
  onUpdate,
  onToggleLock,
  onRename,
}: {
  layer: ImageLayer;
  onUpdate: (patch: Partial<ImageLayer>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
}) {
  const { t } = useTranslation("common");
  const locked = !!layer.locked;
  const [labelDraft, setLabelDraft] = useState(layer.label);
  const [labelDirty, setLabelDirty] = useState(false);

  if (!labelDirty && layer.label !== labelDraft) setLabelDraft(layer.label);

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(layer.label);
      return;
    }
    if (trimmed !== layer.label) onRename(trimmed);
  };

  const opacity = layer.opacity ?? 100;

  return (
    <>
      <Header
        typeLabel={t("roomMap.inspector.typeImage")}
        name={layer.label}
        dotColor={TYPE_DOT_COLOR.image}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`img-name-${layer.id}`}>
          {t("roomMap.inspector.furnitureNameLabel")}
        </label>
        <input
          id={`img-name-${layer.id}`}
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
              setLabelDraft(layer.label);
              setLabelDirty(false);
            }
          }}
        />
      </div>
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`img-opacity-${layer.id}`}>
          {t("roomMap.inspector.imageOpacityLabel")}
        </label>
        <input
          id={`img-opacity-${layer.id}`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={opacity}
          disabled={locked}
          onChange={(e) => onUpdate({ opacity: parseInt(e.target.value, 10) })}
          className="lm-room-dock-slider"
          aria-label={t("roomMap.inspector.imageOpacityLabel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={opacity}
        />
        <span className="lm-room-dock-field-value">{opacity}%</span>
      </div>
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap.objectPanel.unlock") : t("roomMap.objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap.inspector.imageHint")}</p>
    </>
  );
}

/* ── dispatcher helper used by RoomDockPanel ────────────────────── */

/**
 * Resolve the active selection from the dock's `selectedId` shape and
 * the active Hue-zone id. Hue zone wins (W4-C surface), then the
 * selected object, then empty.
 *
 * v1.5 W4-F2: only `HueZone` (Hue Entertainment Area spatial 3D subset)
 * survives. Logical zones were dropped — see RFC §"Direction reversal"
 * — so the dispatcher reads exclusively from `config.zones: HueZone[]`.
 */
export type InspectorTarget =
  | { kind: "hueZone"; zone: HueZone }
  | { kind: "tv"; tv: TvAnchorPlacement }
  | { kind: "furniture"; item: FurniturePlacement }
  | { kind: "usb"; strip: UsbStripPlacement }
  | { kind: "hueChannel"; channel: HueChannelPlacement; zoneName: string | null }
  | { kind: "image"; layer: ImageLayer }
  | { kind: "empty" };

export function resolveInspectorTarget(
  config: RoomMapConfig,
  selectedId: string | null,
  activeHueZoneId: string | null,
): InspectorTarget {
  if (activeHueZoneId) {
    const zone = config.zones.find((z) => z.id === activeHueZoneId);
    if (zone) return { kind: "hueZone", zone };
  }
  if (selectedId) {
    if (selectedId === "tv" && config.tvAnchor) {
      return { kind: "tv", tv: config.tvAnchor };
    }
    if (selectedId.startsWith("furniture-")) {
      const id = selectedId.replace("furniture-", "");
      const item = config.furniture.find((f) => f.id === id);
      if (item) return { kind: "furniture", item };
    }
    if (selectedId.startsWith("usb-")) {
      const id = selectedId.replace("usb-", "");
      const strip = config.usbStrips.find((s) => s.stripId === id);
      if (strip) return { kind: "usb", strip };
    }
    if (selectedId.startsWith("hue-")) {
      const idx = parseInt(selectedId.replace("hue-", ""), 10);
      const channel = config.hueChannels.find((c) => c.channelIndex === idx);
      if (channel) {
        const zoneName = channel.zoneId
          ? config.zones.find((z) => z.id === channel.zoneId)?.name ?? null
          : null;
        return { kind: "hueChannel", channel, zoneName };
      }
    }
    if (selectedId.startsWith("img-")) {
      const id = selectedId.replace("img-", "");
      const layer = config.imageLayers.find((l) => l.id === id);
      if (layer) return { kind: "image", layer };
    }
  }
  return { kind: "empty" };
}
