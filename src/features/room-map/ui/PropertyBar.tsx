import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { findHueChannel } from "@/shared/contracts/roomMap";
import { parseObjectId, type RoomObjectKind, type RoomObjectRef } from "../model/objectId";
import { resolveHueChannelWorld } from "../model/hueChannelPosition";
import { IconLock, IconUnlock, IconOpacity } from "@/shared/ui/icons";

interface PropertyBarProps {
  config: RoomMapConfig;
  selectedId: string | null;
  onUpdatePosition: (id: string, x: number, y: number) => void;
  onUpdateSize: (id: string, w: number, h: number) => void;
  onUpdateRotation: (id: string, rotation: number) => void;
  onUpdateImageOpacity?: (imageId: string, opacity: number) => void;
  onUpdateImageAspectLock?: (imageId: string, locked: boolean) => void;
  onUpdateImageScale?: (imageId: string, sx: number, sy: number) => void;
  onResetImageScale?: (imageId: string) => void;
}

interface FieldValues {
  x: string;
  y: string;
  w: string;
  h: string;
  r: string;
  locked: boolean;
  // Image-specific
  isImage?: boolean;
  sx?: string;
  sy?: string;
  opacity?: string;
  aspectLocked?: boolean;
}

/** What the bar shows for each kind; a new kind fails to compile until it has a row. */
const FIELD_READERS = {
  tv: (config) => {
    const tv = config.tvAnchor;
    if (!tv) return null;
    return { x: tv.x.toFixed(2), y: tv.y.toFixed(2), w: tv.width.toFixed(2), h: tv.height.toFixed(2), r: "", locked: !!tv.locked };
  },
  furniture: (config, ref) => {
    const f = config.furniture.find((item) => item.id === ref.furnitureId);
    if (!f) return null;
    return { x: f.x.toFixed(2), y: f.y.toFixed(2), w: f.width.toFixed(2), h: f.height.toFixed(2), r: String(f.rotation ?? 0), locked: !!f.locked };
  },
  usb: (config, ref) => {
    const s = config.usbStrips.find((item) => item.stripId === ref.stripId);
    if (!s) return null;
    return { x: s.startX.toFixed(2), y: s.startY.toFixed(2), w: "", h: "", r: "", locked: !!s.locked };
  },
  hue: (config, ref) => {
    const ch = findHueChannel(config.hueChannels, ref.channelIndex);
    if (!ch) return null;
    // Zone-bound channels render from `zoneRelativePosition`; reading `ch.x/y`
    // here showed a coordinate the dot was not at.
    const world = resolveHueChannelWorld(ch, config.zones);
    return { x: world.x.toFixed(2), y: world.y.toFixed(2), w: "", h: "", r: "", locked: !!ch.locked };
  },
  image: (config, ref) => {
    const layer = config.imageLayers.find((l) => l.id === ref.layerId);
    if (!layer) return null;
    const sx = layer.scaleX ?? layer.scale;
    const sy = layer.scaleY ?? layer.scale;
    return {
      x: layer.offsetX.toFixed(1),
      y: layer.offsetY.toFixed(1),
      w: "", h: "", r: "",
      locked: !!layer.locked,
      isImage: true,
      sx: sx.toFixed(2),
      sy: sy.toFixed(2),
      opacity: String(layer.opacity ?? 100),
      aspectLocked: layer.aspectLocked !== false,
    };
  },
} satisfies { [K in RoomObjectKind]: (config: RoomMapConfig, ref: RoomObjectRef<K>) => FieldValues | null };

function getFieldValues(config: RoomMapConfig, id: string | null): FieldValues | null {
  const ref = id ? parseObjectId(id) : null;
  if (!ref) return null;
  const read = FIELD_READERS[ref.kind] as (config: RoomMapConfig, ref: RoomObjectRef) => FieldValues | null;
  return read(config, ref);
}

function NumberInput({
  label,
  ariaLabel,
  value,
  onChange,
  disabled,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (val: number) => void;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const commit = useCallback(() => {
    const num = parseFloat(local);
    if (!isNaN(num)) onChange(num);
    else setLocal(value);
  }, [local, onChange, value]);

  if (value === "") return null;

  return (
    <label className={`lm-room-propbar-field ${disabled ? "is-disabled" : ""}`}>
      <span className="lm-room-propbar-field-label" aria-hidden>{label}</span>
      <input
        type="number"
        step="any"
        aria-label={ariaLabel}
        disabled={disabled}
        className="lm-room-propbar-input"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); }}
      />
    </label>
  );
}

export function PropertyBar({
  config,
  selectedId,
  onUpdatePosition,
  onUpdateSize,
  onUpdateRotation,
  onUpdateImageOpacity,
  onUpdateImageScale,
  onUpdateImageAspectLock,
  onResetImageScale,
}: PropertyBarProps) {
  const { t } = useTranslation();
  const fields = getFieldValues(config, selectedId);

  if (!fields || !selectedId) {
    return (
      // The 32 px stays reserved with nothing selected. Collapsing it would
      // shift the canvas on every select and deselect, which is worse than the
      // gap; what was wrong was filling it with an em dash, which says nothing
      // and reads as a rendering fault.
      <div className="lm-room-propbar lm-room-propbar--empty">
        <span className="lm-room-propbar-empty">{t("roomMap:propertyBar.empty")}</span>
      </div>
    );
  }

  const locked = fields.locked;
  const parsedSelection = selectedId ? parseObjectId(selectedId) : null;
  const imgId = parsedSelection?.kind === "image" ? parsedSelection.layerId : null;

  if (fields.isImage && imgId) {
    return (
      <div className="lm-room-propbar">
        <NumberInput
          label="X"
          ariaLabel={t("roomMap:propertyBar.fields.x")}
          value={fields.x}
          onChange={(v) => onUpdatePosition(selectedId, v, parseFloat(fields.y))}
          disabled={locked}
        />
        <NumberInput
          label="Y"
          ariaLabel={t("roomMap:propertyBar.fields.y")}
          value={fields.y}
          onChange={(v) => onUpdatePosition(selectedId, parseFloat(fields.x), v)}
          disabled={locked}
        />

        <span className="lm-room-propbar-sep" aria-hidden />

        {/* Aspect lock toggle */}
        <button
          className={`flex items-center justify-center w-8 h-8 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60 ${
            locked
              ? "opacity-40 cursor-not-allowed text-ink-faint"
              : fields.aspectLocked
                ? "text-amber"
                : "text-ink-dim hover:text-ink"
          }`}
          onClick={locked ? undefined : () => onUpdateImageAspectLock?.(imgId, !fields.aspectLocked)}
          disabled={locked}
          aria-label={fields.aspectLocked ? t("roomMap:propertyBar.aspectLocked") : t("roomMap:propertyBar.aspectUnlocked")}
          title={fields.aspectLocked ? t("roomMap:propertyBar.aspectLocked") : t("roomMap:propertyBar.aspectUnlocked")}
        >
          {fields.aspectLocked ? <IconLock /> : <IconUnlock />}
        </button>

        {/* Scale X / Scale Y */}
        {fields.aspectLocked ? (
          <NumberInput
            label="S"
            ariaLabel={t("roomMap:propertyBar.fields.scale")}
            value={fields.sx!}
            onChange={(v) => {
              const oldSx = parseFloat(fields.sx!);
              const oldSy = parseFloat(fields.sy!);
              const clamped = Math.max(0.05, v);
              // Preserve current sx:sy ratio
              const ratio = oldSx > 0 ? oldSy / oldSx : 1;
              onUpdateImageScale?.(imgId, clamped, Math.max(0.05, clamped * ratio));
            }}
            disabled={locked}
          />
        ) : (
          <>
            <NumberInput
              label="W"
              ariaLabel={t("roomMap:propertyBar.fields.scaleX")}
              value={fields.sx!}
              onChange={(v) => onUpdateImageScale?.(imgId, Math.max(0.05, v), parseFloat(fields.sy!))}
              disabled={locked}
            />
            <NumberInput
              label="H"
              ariaLabel={t("roomMap:propertyBar.fields.scaleY")}
              value={fields.sy!}
              onChange={(v) => onUpdateImageScale?.(imgId, parseFloat(fields.sx!), Math.max(0.05, v))}
              disabled={locked}
            />
          </>
        )}

        {/* Reset to original size */}
        <button
          className={`flex items-center justify-center w-8 h-8 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60 ${
            locked
              ? "opacity-40 cursor-not-allowed text-ink-faint"
              : "text-ink-dim hover:text-ink"
          }`}
          onClick={locked ? undefined : () => onResetImageScale?.(imgId)}
          disabled={locked}
          aria-label={t("roomMap:propertyBar.resetScale")}
          title={t("roomMap:propertyBar.resetScale")}
        >
          <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8a6 6 0 0 1 10.2-4.2" />
            <path d="M14 8a6 6 0 0 1-10.2 4.2" />
            <path d="M12 2v2.5h-2.5" />
            <path d="M4 14v-2.5h2.5" />
          </svg>
        </button>

        <span className="lm-room-propbar-sep" aria-hidden />

        {/* Opacity — compact inline */}
        <div className={`flex items-center gap-1.5 ${locked ? "opacity-40 pointer-events-none" : ""}`}>
          <IconOpacity />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            disabled={locked}
            value={parseInt(fields.opacity!, 10)}
            onChange={(e) => onUpdateImageOpacity?.(imgId, parseInt(e.target.value, 10))}
            aria-label={t("roomMap:inspector.imageOpacityLabel")}
            className="w-12 h-[3px] appearance-none rounded-full bg-line-2 accent-amber [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber [&::-webkit-slider-thumb]:cursor-pointer disabled:cursor-not-allowed"
          />
          <span className="w-5 text-right tabular-nums text-[9px] font-medium text-ink-dim">{fields.opacity}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="lm-room-propbar">
      <NumberInput
        label="X"
        ariaLabel={t("roomMap:propertyBar.fields.x")}
        value={fields.x}
        onChange={(v) => onUpdatePosition(selectedId, v, parseFloat(fields.y))}
        disabled={locked}
      />
      <NumberInput
        label="Y"
        ariaLabel={t("roomMap:propertyBar.fields.y")}
        value={fields.y}
        onChange={(v) => onUpdatePosition(selectedId, parseFloat(fields.x), v)}
        disabled={locked}
      />
      <NumberInput
        label="W"
        ariaLabel={t("roomMap:propertyBar.fields.width")}
        value={fields.w}
        onChange={(v) => onUpdateSize(selectedId, v, parseFloat(fields.h))}
        disabled={locked}
      />
      <NumberInput
        label="H"
        ariaLabel={t("roomMap:propertyBar.fields.height")}
        value={fields.h}
        onChange={(v) => onUpdateSize(selectedId, parseFloat(fields.w), v)}
        disabled={locked}
      />
      <NumberInput
        label="R"
        ariaLabel={t("roomMap:propertyBar.fields.rotation")}
        value={fields.r}
        onChange={(v) => onUpdateRotation(selectedId, v)}
        disabled={locked}
      />
    </div>
  );
}
