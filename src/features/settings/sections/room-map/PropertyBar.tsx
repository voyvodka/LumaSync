import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";

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

function getFieldValues(config: RoomMapConfig, id: string | null): FieldValues | null {
  if (!id) return null;

  if (id === "tv" && config.tvAnchor) {
    const tv = config.tvAnchor;
    return { x: tv.x.toFixed(2), y: tv.y.toFixed(2), w: tv.width.toFixed(2), h: tv.height.toFixed(2), r: "", locked: !!tv.locked };
  }

  if (id.startsWith("furniture-")) {
    const fId = id.replace("furniture-", "");
    const f = config.furniture.find((item) => item.id === fId);
    if (!f) return null;
    return { x: f.x.toFixed(2), y: f.y.toFixed(2), w: f.width.toFixed(2), h: f.height.toFixed(2), r: String(f.rotation ?? 0), locked: !!f.locked };
  }

  if (id.startsWith("usb-")) {
    const sId = id.replace("usb-", "");
    const s = config.usbStrips.find((item) => item.stripId === sId);
    if (!s) return null;
    return { x: s.startX.toFixed(2), y: s.startY.toFixed(2), w: "", h: "", r: "", locked: !!s.locked };
  }

  if (id.startsWith("hue-")) {
    const idx = parseInt(id.replace("hue-", ""), 10);
    const ch = config.hueChannels[idx];
    if (!ch) return null;
    return { x: ch.x.toFixed(2), y: ch.y.toFixed(2), w: "", h: "", r: "", locked: !!ch.locked };
  }

  if (id.startsWith("img-")) {
    const imgId = id.replace("img-", "");
    const layer = config.imageLayers.find((l) => l.id === imgId);
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
  }

  return null;
}

function NumberInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
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
    <label className={`flex items-center gap-1 text-[10px] ${disabled ? "opacity-40 pointer-events-none" : "text-slate-500 dark:text-zinc-400"}`}>
      <span className="font-semibold w-3">{label}</span>
      <input
        type="number"
        step="any"
        disabled={disabled}
        className="w-[52px] bg-transparent border-b border-slate-300 dark:border-zinc-600 text-[10px] text-slate-800 dark:text-zinc-200 text-center focus:outline-none focus:border-cyan-400 tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(); }}
      />
    </label>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function IconUnlock() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0" />
    </svg>
  );
}

function IconOpacity() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12" />
      <path d="M8 2a6 6 0 0 1 0 12" fill="currentColor" opacity="0.3" />
    </svg>
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
  const { t } = useTranslation("common");
  const fields = getFieldValues(config, selectedId);

  if (!fields || !selectedId) {
    return (
      <div className="h-8 shrink-0 flex items-center px-3 border-t border-slate-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80">
        <span className="text-[10px] text-slate-400 dark:text-zinc-500">—</span>
      </div>
    );
  }

  const locked = fields.locked;
  const imgId = selectedId.startsWith("img-") ? selectedId.replace("img-", "") : null;

  if (fields.isImage && imgId) {
    return (
      <div className="h-8 shrink-0 flex items-center gap-3 px-3 border-t border-slate-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80">
        <NumberInput
          label="X"
          value={fields.x}
          onChange={(v) => onUpdatePosition(selectedId, v, parseFloat(fields.y))}
          disabled={locked}
        />
        <NumberInput
          label="Y"
          value={fields.y}
          onChange={(v) => onUpdatePosition(selectedId, parseFloat(fields.x), v)}
          disabled={locked}
        />

        <div className="h-4 w-px bg-slate-200 dark:bg-zinc-700" />

        {/* Aspect lock toggle */}
        <button
          className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
            locked
              ? "opacity-40 cursor-not-allowed text-slate-400 dark:text-zinc-600"
              : fields.aspectLocked
                ? "text-cyan-500"
                : "text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"
          }`}
          onClick={locked ? undefined : () => onUpdateImageAspectLock?.(imgId, !fields.aspectLocked)}
          disabled={locked}
          title={fields.aspectLocked ? t("roomMap.propertyBar.aspectLocked") : t("roomMap.propertyBar.aspectUnlocked")}
        >
          {fields.aspectLocked ? <IconLock /> : <IconUnlock />}
        </button>

        {/* Scale X / Scale Y */}
        {fields.aspectLocked ? (
          <NumberInput
            label="S"
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
              value={fields.sx!}
              onChange={(v) => onUpdateImageScale?.(imgId, Math.max(0.05, v), parseFloat(fields.sy!))}
              disabled={locked}
            />
            <NumberInput
              label="H"
              value={fields.sy!}
              onChange={(v) => onUpdateImageScale?.(imgId, parseFloat(fields.sx!), Math.max(0.05, v))}
              disabled={locked}
            />
          </>
        )}

        {/* Reset to original size */}
        <button
          className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
            locked
              ? "opacity-40 cursor-not-allowed text-slate-400 dark:text-zinc-600"
              : "text-slate-400 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-200"
          }`}
          onClick={locked ? undefined : () => onResetImageScale?.(imgId)}
          disabled={locked}
          title={t("roomMap.propertyBar.resetScale")}
        >
          <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8a6 6 0 0 1 10.2-4.2" />
            <path d="M14 8a6 6 0 0 1-10.2 4.2" />
            <path d="M12 2v2.5h-2.5" />
            <path d="M4 14v-2.5h2.5" />
          </svg>
        </button>

        <div className="h-4 w-px bg-slate-200 dark:bg-zinc-700" />

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
            className="w-12 h-[3px] appearance-none rounded-full bg-slate-300 dark:bg-zinc-600 accent-cyan-500 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-500 [&::-webkit-slider-thumb]:cursor-pointer disabled:cursor-not-allowed"
          />
          <span className="w-5 text-right tabular-nums text-[9px] font-medium text-slate-600 dark:text-zinc-300">{fields.opacity}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-8 shrink-0 flex items-center gap-3 px-3 border-t border-slate-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80">
      <NumberInput
        label="X"
        value={fields.x}
        onChange={(v) => onUpdatePosition(selectedId, v, parseFloat(fields.y))}
        disabled={locked}
      />
      <NumberInput
        label="Y"
        value={fields.y}
        onChange={(v) => onUpdatePosition(selectedId, parseFloat(fields.x), v)}
        disabled={locked}
      />
      <NumberInput
        label="W"
        value={fields.w}
        onChange={(v) => onUpdateSize(selectedId, v, parseFloat(fields.h))}
        disabled={locked}
      />
      <NumberInput
        label="H"
        value={fields.h}
        onChange={(v) => onUpdateSize(selectedId, parseFloat(fields.w), v)}
        disabled={locked}
      />
      <NumberInput
        label="R"
        value={fields.r}
        onChange={(v) => onUpdateRotation(selectedId, v)}
        disabled={locked}
      />
    </div>
  );
}
