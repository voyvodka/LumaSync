import { useTranslation } from "react-i18next";
import { IconButton } from "@/shared/ui/Button";

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

  return (
    <div
      className="lm-room-overlay lm-room-overlay--start"
      role="group"
      aria-label={t("roomMap:zoomControl.label")}
    >
      <IconButton
        className="lm-room-viewport-btn"
        onClick={() => step(-ZOOM_STEP)}
        disabled={zoom <= ZOOM_MIN}
        label={t("roomMap:zoomControl.out")}
        icon="−"
      />
      <button
        type="button"
        className="lm-room-viewport-btn lm-room-viewport-btn--readout"
        onClick={onFitToView}
        aria-label={t("roomMap:zoomControl.fit")}
        title={`${t("roomMap:zoomControl.fit")} · ${isMac ? "⌘0" : "Ctrl+0"}`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        className="lm-room-viewport-btn"
        onClick={() => step(ZOOM_STEP)}
        disabled={zoom >= ZOOM_MAX}
        label={t("roomMap:zoomControl.in")}
        icon="+"
      />
    </div>
  );
}
