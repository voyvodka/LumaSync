import { useTranslation } from "react-i18next";

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;

interface ZoomControlProps {
  zoom: number;
  canvasSize: { w: number; h: number };
  panOffset: { x: number; y: number };
  onZoomChange: (zoom: number) => void;
  onPanChange: (pan: { x: number; y: number }) => void;
  onFitToView: () => void;
  isMac: boolean;
}

/** Zoom and fit were reachable only by wheel or by an unadvertised `Cmd/Ctrl+0`,
 *  leaving keyboard-only and trackpad-less users with no way in. */
export function ZoomControl({
  zoom,
  canvasSize,
  panOffset,
  onZoomChange,
  onPanChange,
  onFitToView,
  isMac,
}: ZoomControlProps) {
  const { t } = useTranslation();

  // Anchor on the canvas centre, the way the wheel anchors on the pointer —
  // without this the room slides off as you step in.
  const step = (delta: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta));
    if (next === zoom) return;
    const cx = canvasSize.w / 2;
    const cy = canvasSize.h / 2;
    onZoomChange(next);
    onPanChange({
      x: cx - ((cx - panOffset.x) / zoom) * next,
      y: cy - ((cy - panOffset.y) / zoom) * next,
    });
  };

  const btn =
    "flex h-8 w-8 items-center justify-center rounded text-[13px] text-[color:var(--lm-text-dim)] " +
    "hover:text-[color:var(--lm-text)] disabled:opacity-40 disabled:hover:text-[color:var(--lm-text-dim)] " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--lm-accent)]";

  return (
    <div
      className="absolute bottom-1 left-1 z-50 flex items-center gap-0.5 rounded bg-black/60 px-0.5"
      role="group"
      aria-label={t("roomMap:zoomControl.label")}
    >
      <button
        type="button"
        className={btn}
        onClick={() => step(-ZOOM_STEP)}
        disabled={zoom <= ZOOM_MIN}
        aria-label={t("roomMap:zoomControl.out")}
        title={t("roomMap:zoomControl.out")}
      >
        −
      </button>
      <button
        type="button"
        className="h-8 min-w-[52px] rounded px-1 text-[10px] [font-family:var(--lm-mono)] tabular-nums text-[color:var(--lm-text-dim)] hover:text-[color:var(--lm-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--lm-accent)]"
        onClick={onFitToView}
        aria-label={t("roomMap:zoomControl.fit")}
        title={`${t("roomMap:zoomControl.fit")} · ${isMac ? "⌘0" : "Ctrl+0"}`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => step(ZOOM_STEP)}
        disabled={zoom >= ZOOM_MAX}
        aria-label={t("roomMap:zoomControl.in")}
        title={t("roomMap:zoomControl.in")}
      >
        +
      </button>
    </div>
  );
}
