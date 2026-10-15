import type React from "react";
import { memo, useRef, useState, useEffect, useCallback, useId, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SelectionLayerContext } from "./objects/selectionLayer";
import { type RoomMapConfig, type ImageLayer, resolveRoomFootprint } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";
import { prefersReducedMotion } from "@/shared/lib/motion";
import { imageLayerObjectId } from "../model/objectId";
import { CLICK_SLOP_PX } from "../model/snapGeometry";
import { pastSlop } from "./objects/dragIntent";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../state/useRoomMapViewport";
import { readRoomMapImage } from "../roomMapFilesApi";

type ResizeCorner = "nw" | "ne" | "sw" | "se";

/** `continuous` marks a write from a control that fires per input event — the
 *  wheel — so the editor can fold a burst of them into one undo step. */
export type ImageLayerTransformHandler = (
  id: string,
  offsetX: number,
  offsetY: number,
  scale: number,
  scaleX?: number,
  scaleY?: number,
  continuous?: boolean,
) => void;

/** Draggable + resizable image layer (lives inside object layer). */
const ImageLayerView = memo(function ImageLayerView({
  layer, zoom, selected, panMode, onSelect, onTransformChange,
}: {
  layer: ImageLayer;
  zoom: number;
  selected?: boolean;
  panMode?: boolean;
  onSelect?: (id: string) => void;
  onTransformChange?: ImageLayerTransformHandler;
}) {
  const canDrag = selected && !layer.locked;
  const aspectLocked = layer.aspectLocked !== false; // default true

  const dragRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number }>({
    active: false, startX: 0, startY: 0, ox: 0, oy: 0,
  });
  const resizeRef = useRef<{
    active: boolean; corner: ResizeCorner; startX: number; startY: number;
    initSx: number; initSy: number; initOx: number; initOy: number;
    imgW: number; imgH: number;
  }>({ active: false, corner: "se", startX: 0, startY: 0, initSx: 1, initSy: 1, initOx: 0, initOy: 0, imgW: 0, imgH: 0 });

  const [localOx, setLocalOx] = useState(layer.offsetX);
  const [localOy, setLocalOy] = useState(layer.offsetY);
  const [localSx, setLocalSx] = useState(layer.scaleX ?? layer.scale);
  const [localSy, setLocalSy] = useState(layer.scaleY ?? layer.scale);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  // Read image file → blob URL
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    readRoomMapImage(layer.path)
      .then((data) => {
        if (revoked) return;
        const ext = layer.path.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
        url = URL.createObjectURL(new Blob([data], { type: mime }));
        setBlobUrl(url);
      })
      .catch((error: unknown) => {
        console.error(`[LumaSync] room map image layer read failed (${layer.path}):`, error);
        if (!revoked) setBlobUrl(null);
      });
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [layer.path]);

  // Sync local state from props
  const prevProps = useRef({ offsetX: layer.offsetX, offsetY: layer.offsetY, scale: layer.scale, scaleX: layer.scaleX, scaleY: layer.scaleY });
  const nextSx = layer.scaleX ?? layer.scale;
  const nextSy = layer.scaleY ?? layer.scale;
  if (prevProps.current.offsetX !== layer.offsetX || prevProps.current.offsetY !== layer.offsetY || prevProps.current.scale !== layer.scale || prevProps.current.scaleX !== layer.scaleX || prevProps.current.scaleY !== layer.scaleY) {
    prevProps.current = { offsetX: layer.offsetX, offsetY: layer.offsetY, scale: layer.scale, scaleX: layer.scaleX, scaleY: layer.scaleY };
    setLocalOx(layer.offsetX);
    setLocalOy(layer.offsetY);
    setLocalSx(nextSx);
    setLocalSy(nextSy);
  }

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Latched once a press leaves its spot, so coming back near it still follows the pointer.
  const movedRef = useRef(false);

  // --- Drag handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (panMode) return;
    e.stopPropagation();
    onSelect?.(layer.id);
    if (!canDrag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: localOx, oy: localOy };
    movedRef.current = false;
  }, [localOx, localOy, canDrag, panMode, onSelect, layer.id]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    if (!movedRef.current && !pastSlop(dragRef.current.startX, dragRef.current.startY, e.clientX, e.clientY)) return;
    movedRef.current = true;
    const dx = (e.clientX - dragRef.current.startX) / zoomRef.current;
    const dy = (e.clientY - dragRef.current.startY) / zoomRef.current;
    setLocalOx(dragRef.current.ox + dx);
    setLocalOy(dragRef.current.oy + dy);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    // A click selects; only a move is a step to undo.
    if (localOx === dragRef.current.ox && localOy === dragRef.current.oy) return;
    onTransformChange?.(layer.id, localOx, localOy, layer.scale, localSx, localSy);
  }, [layer.id, layer.scale, localOx, localOy, localSx, localSy, onTransformChange]);

  // --- Resize handlers ---
  const handleResizePointerDown = useCallback((corner: ResizeCorner, e: React.PointerEvent) => {
    if (panMode || !canDrag) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = {
      active: true, corner, startX: e.clientX, startY: e.clientY,
      initSx: localSx, initSy: localSy, initOx: localOx, initOy: localOy,
      imgW: naturalSize?.w ?? 100, imgH: naturalSize?.h ?? 100,
    };
    movedRef.current = false;
  }, [panMode, canDrag, localSx, localSy, localOx, localOy, naturalSize]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r.active) return;
    if (!movedRef.current && !pastSlop(r.startX, r.startY, e.clientX, e.clientY)) return;
    movedRef.current = true;
    const dx = (e.clientX - r.startX) / zoomRef.current;
    const dy = (e.clientY - r.startY) / zoomRef.current;

    // Sign for each corner
    const sx_sign = r.corner === "nw" || r.corner === "sw" ? -1 : 1;
    const sy_sign = r.corner === "nw" || r.corner === "ne" ? -1 : 1;

    if (aspectLocked) {
      // Proportional resize — preserve the current sx:sy ratio
      const avgDelta = (dx * sx_sign + dy * sy_sign) / 2;
      const baseDim = Math.max(r.imgW * r.initSx, r.imgH * r.initSy, 1);
      const factor = 1 + avgDelta / baseDim;
      const nsx = Math.max(0.05, r.initSx * factor);
      const nsy = Math.max(0.05, r.initSy * factor);
      setLocalSx(nsx);
      setLocalSy(nsy);
      if (r.corner === "nw" || r.corner === "sw") setLocalOx(r.initOx - (nsx - r.initSx) * r.imgW);
      if (r.corner === "nw" || r.corner === "ne") setLocalOy(r.initOy - (nsy - r.initSy) * r.imgH);
    } else {
      const nsx = Math.max(0.05, r.initSx + (dx * sx_sign) / r.imgW);
      const nsy = Math.max(0.05, r.initSy + (dy * sy_sign) / r.imgH);
      setLocalSx(nsx);
      setLocalSy(nsy);
      if (r.corner === "nw" || r.corner === "sw") setLocalOx(r.initOx - (nsx - r.initSx) * r.imgW);
      if (r.corner === "nw" || r.corner === "ne") setLocalOy(r.initOy - (nsy - r.initSy) * r.imgH);
    }
  }, [aspectLocked]);

  const handleResizePointerUp = useCallback(() => {
    if (!resizeRef.current.active) return;
    resizeRef.current.active = false;
    onTransformChange?.(layer.id, localOx, localOy, layer.scale, localSx, localSy);
  }, [layer.id, layer.scale, localOx, localOy, localSx, localSy, onTransformChange]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!canDrag) return;
    e.stopPropagation();
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    if (aspectLocked) {
      // Proportional — multiply both by same factor to preserve ratio
      const nsx = Math.max(0.05, localSx * factor);
      const nsy = Math.max(0.05, localSy * factor);
      setLocalSx(nsx);
      setLocalSy(nsy);
      onTransformChange?.(layer.id, localOx, localOy, layer.scale, nsx, nsy, true);
    } else {
      const nsx = Math.max(0.05, localSx * factor);
      const nsy = Math.max(0.05, localSy * factor);
      setLocalSx(nsx);
      setLocalSy(nsy);
      onTransformChange?.(layer.id, localOx, localOy, layer.scale, nsx, nsy, true);
    }
  }, [layer.id, layer.scale, localOx, localOy, localSx, localSy, onTransformChange, canDrag, aspectLocked]);

  if (!blobUrl) return null;

  const layerOpacity = (layer.opacity ?? 100) / 100;
  const imgW = naturalSize ? naturalSize.w * localSx : 0;
  const imgH = naturalSize ? naturalSize.h * localSy : 0;

  // a11y-exception: the 32x32 hit zone meets the tap-target floor while the
  // visible handle stays 8x8 so it does not occlude the image beneath it.
  const HIT_ZONE_CLASSES: Record<ResizeCorner, string> = {
    nw: "top-[-16px] left-[-16px] cursor-nwse-resize",
    ne: "top-[-16px] right-[-16px] cursor-nesw-resize",
    sw: "bottom-[-16px] left-[-16px] cursor-nesw-resize",
    se: "bottom-[-16px] right-[-16px] cursor-nwse-resize",
  };
  const cornerKeys: ResizeCorner[] = ["nw", "ne", "sw", "se"];

  return (
    <div
      className="absolute"
      style={{
        zIndex: 2,
        transform: `translate(${localOx}px, ${localOy}px)`,
        transformOrigin: "top left",
        width: imgW || undefined,
        height: imgH || undefined,
        outline: selected ? `2px solid ${layer.locked ? "rgba(255,255,255,0.4)" : "#ffffff"}` : "none",
        outlineOffset: "-1px",
      }}
    >
      <img
        src={blobUrl}
        alt={layer.label}
        className={`select-none ${canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
        draggable={false}
        style={{
          opacity: layerOpacity, maxWidth: "none", display: "block",
          width: imgW || undefined, height: imgH || undefined,
        }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (!naturalSize) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      />
      {/* Resize corner handles — same style as Furniture/TV ResizeHandle.
          The outer div is a 32x32 transparent hit zone (a11y tap-target);
          the inner span renders the visible 8x8 handle centered on the
          parent corner. */}
      {selected && canDrag && naturalSize && cornerKeys.map((key) => (
        <div
          key={key}
          className={`absolute h-8 w-8 ${HIT_ZONE_CLASSES[key]}`}
          onPointerDown={(e) => handleResizePointerDown(key, e)}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        >
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-ink bg-bg"
            aria-hidden
          />
        </div>
      ))}
    </div>
  );
});

function layerTransform(x: number, y: number, zoom: number): string {
  return `translate(${x}px, ${y}px) scale(${zoom})`;
}

const ORIGIN = { x: 0, y: 0 };

interface RoomMapCanvasProps {
  config: RoomMapConfig;
  pxPerMeter: number;
  /** Measured by the viewport hook, which owns the container. */
  canvasSize: { w: number; h: number };
  showGrid: boolean;
  gridStrokeWidth: number;
  selectedId: string | null;
  onCanvasClick: () => void;
  onImageLayerTransformChange?: ImageLayerTransformHandler;
  onImageLayerSelect?: (id: string) => void;
  zoom?: number;
  panOffset?: { x: number; y: number };
  onZoomChange?: (zoom: number) => void;
  onPanChange?: (offset: { x: number; y: number }) => void;
  panMode?: boolean;
  /** A piece is being dragged: the grid steps forward so the snap it follows can be seen. */
  dragging?: boolean;
  /** A box dragged across empty floor, in room metres: what it covers is selected (⇧ adds). */
  onMarquee?: (box: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => void;
  children?: React.ReactNode;
}

/** Changes to the view inside this long after the plan mounts are its opening fit, not a move. */
const OPENING_SETTLE_MS = 500;
/** How long a wheel pan waits after the last event before it commits the offset. */
const WHEEL_PAN_SETTLE_MS = 120;

export function RoomMapCanvas({
  config,
  pxPerMeter,
  canvasSize,
  showGrid,
  gridStrokeWidth,
  selectedId,
  onCanvasClick,
  onImageLayerTransformChange,
  onImageLayerSelect,
  zoom = 1,
  panOffset = ORIGIN,
  onZoomChange,
  onPanChange,
  panMode = false,
  dragging = false,
  onMarquee,
  children,
}: RoomMapCanvasProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLDivElement>(null);
  const objectLayerRef = useRef<HTMLDivElement>(null);
  const [selectionLayer, setSelectionLayer] = useState<HTMLDivElement | null>(null);
  // A zoom or pan from a button (+, −, fit, an arrow key) eases there; one the pointer drives — a
  // drag, the wheel, a pinch — follows it at once, or the plan would lag behind the hand.
  const pointerDriven = useRef(false);
  // The plan opens framed, not travelling there: the first fit lands before the easing starts.
  const openedAt = useRef<number | null>(null);
  if (openedAt.current === null) openedAt.current = performance.now();
  const viewKey = `${zoom}:${panOffset.x}:${panOffset.y}`;
  const lastView = useRef(viewKey);
  useLayoutEffect(() => {
    if (lastView.current === viewKey) return;
    lastView.current = viewKey;
    const layer = objectLayerRef.current;
    if (!layer) return;
    const settled = performance.now() - (openedAt.current ?? 0) > OPENING_SETTLE_MS;
    const eased = settled && !pointerDriven.current && !prefersReducedMotion();
    pointerDriven.current = false;
    layer.style.transition = eased ? "transform var(--lm-dur-base) var(--lm-ease-out)" : "none";
  }, [viewKey]);

  const { widthMeters, depthMeters } = config.dimensions;
  const outline = useMemo(
    () => resolveRoomFootprint({ dimensions: config.dimensions, footprint: config.footprint }),
    [config.dimensions, config.footprint],
  );
  // A url(#…) reference cannot take the characters React puts in an id.
  const cutPatternId = `room-cut-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // Grid interval: 0.5m if room width < 4m, else 1.0m
  const gridInterval = widthMeters < 4 ? 0.5 : 1.0;

  // A pan moves the object layer's transform directly and commits the offset
  // once, on release: committing per move re-rendered the editor and every
  // object on the canvas at pointer rate for a change that is one CSS property.
  const panRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number; x: number; y: number }>({
    active: false, startX: 0, startY: 0, ox: 0, oy: 0, x: 0, y: 0,
  });

  // Two fingers on a trackpad pan and a pinch zooms, as every map does; a mouse wheel's notches
  // still zoom. Every wheel event used to zoom, so a trackpad could not move the plan at all.
  const wheelPanRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  useEffect(
    () => () => {
      const pending = wheelPanRef.current;
      if (pending?.timer) clearTimeout(pending.timer);
    },
    [],
  );
  const handleCanvasWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!onZoomChange || !onPanChange) return;
      const pinch = e.ctrlKey;
      const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (!pinch && !notch) {
        const pending = wheelPanRef.current ?? { x: panOffset.x, y: panOffset.y, timer: null };
        pending.x -= e.deltaX;
        pending.y -= e.deltaY;
        const layer = objectLayerRef.current;
        if (layer) {
          layer.style.transition = "none";
          layer.style.transform = layerTransform(pending.x, pending.y, zoom);
        }
        if (pending.timer) clearTimeout(pending.timer);
        // One commit after the gesture, as a drag pan does: per event re-rendered every object.
        pending.timer = setTimeout(() => {
          wheelPanRef.current = null;
          pointerDriven.current = true;
          onPanChange({ x: pending.x, y: pending.y });
        }, WHEEL_PAN_SETTLE_MS);
        wheelPanRef.current = pending;
        return;
      }
      const base = wheelPanRef.current ?? panOffset;
      const next = pinch
        ? clamp(zoom * Math.exp(-e.deltaY * 0.01), ZOOM_MIN, ZOOM_MAX)
        : clamp(zoom + (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) { onZoomChange(next); return; }
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Keep the point under the pointer fixed: newPan = m - (m - pan) / oldZoom * newZoom.
      const newPanX = mx - ((mx - base.x) / zoom) * next;
      const newPanY = my - ((my - base.y) / zoom) * next;
      const pending = wheelPanRef.current;
      if (pending?.timer) clearTimeout(pending.timer);
      wheelPanRef.current = null;
      pointerDriven.current = true;
      onZoomChange(next);
      onPanChange({ x: newPanX, y: newPanY });
    },
    [zoom, panOffset, onZoomChange, onPanChange],
  );

  // A box across empty floor selects what it covers; the click that ends it is not a deselect.
  const marqueeRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const swallowClick = useRef(false);

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const onFloor = e.target === e.currentTarget || e.target === objectLayerRef.current;
      if (!panMode && e.button === 0 && onFloor && onMarquee) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        marqueeRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, id: e.pointerId };
        return;
      }
      if (panMode || e.button === 1) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        panRef.current = {
          active: true,
          startX: e.clientX,
          startY: e.clientY,
          ox: panOffset.x,
          oy: panOffset.y,
          x: panOffset.x,
          y: panOffset.y,
        };
      }
    },
    [panOffset, panMode, onMarquee],
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const m = marqueeRef.current;
      if (m) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (Math.hypot(x - m.x, y - m.y) < CLICK_SLOP_PX && marquee === null) return;
        setMarquee({ left: Math.min(m.x, x), top: Math.min(m.y, y), width: Math.abs(x - m.x), height: Math.abs(y - m.y) });
        return;
      }
      const pan = panRef.current;
      if (!pan.active) return;
      pan.x = pan.ox + e.clientX - pan.startX;
      pan.y = pan.oy + e.clientY - pan.startY;
      const layer = objectLayerRef.current;
      if (layer) {
        layer.style.transition = "none";
        layer.style.transform = layerTransform(pan.x, pan.y, zoom);
      }
    },
    [zoom, marquee],
  );

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (marqueeRef.current) {
      marqueeRef.current = null;
      const box = marquee;
      setMarquee(null);
      if (box && onMarquee) {
        swallowClick.current = true;
        const ppm = pxPerMeter * zoom;
        onMarquee(
          {
            x0: (box.left - panOffset.x) / ppm,
            y0: (box.top - panOffset.y) / ppm,
            x1: (box.left + box.width - panOffset.x) / ppm,
            y1: (box.top + box.height - panOffset.y) / ppm,
          },
          e.shiftKey,
        );
      }
      return;
    }
    const pan = panRef.current;
    if (!pan.active) return;
    pan.active = false;
    if (pan.x !== pan.ox || pan.y !== pan.oy) {
      pointerDriven.current = true;
      onPanChange?.({ x: pan.x, y: pan.y });
    }
  }, [onPanChange, marquee, onMarquee, pxPerMeter, zoom, panOffset]);

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      if (e.target === e.currentTarget) {
        onCanvasClick();
      }
    },
    [onCanvasClick],
  );

  // Grid anchored to room center — lines radiate from center in all 4 directions
  const centerXm = widthMeters / 2;
  const centerYm = depthMeters / 2;

  // Compute visible area in object-layer (metre) coordinates for infinite grid
  const visMinXm = -panOffset.x / (pxPerMeter * zoom);
  const visMinYm = -panOffset.y / (pxPerMeter * zoom);
  const visMaxXm = visMinXm + canvasSize.w / (pxPerMeter * zoom);
  const visMaxYm = visMinYm + canvasSize.h / (pxPerMeter * zoom);
  // Extend grid well beyond visible area, aligned to center. The extra screen
  // on each side is what a pan in flight reveals before it commits and the
  // grid is rebuilt around the new offset.
  const gridPadM = gridInterval * 2 + Math.max(canvasSize.w, canvasSize.h) / (pxPerMeter * zoom);
  const stepsLeft = Math.ceil((centerXm - visMinXm + gridPadM) / gridInterval);
  const stepsRight = Math.ceil((visMaxXm - centerXm + gridPadM) / gridInterval);
  const stepsUp = Math.ceil((centerYm - visMinYm + gridPadM) / gridInterval);
  const stepsDown = Math.ceil((visMaxYm - centerYm + gridPadM) / gridInterval);
  const gridStartX = centerXm - stepsLeft * gridInterval;
  const gridEndX = centerXm + stepsRight * gridInterval;
  const gridStartY = centerYm - stepsUp * gridInterval;
  const gridEndY = centerYm + stepsDown * gridInterval;

  const gridLines: React.ReactNode[] = [];
  if (showGrid && canvasSize.w > 0) {
    // SVG bounds in px (object-layer coords)
    const svgMinX = gridStartX * pxPerMeter;
    const svgMinY = gridStartY * pxPerMeter;
    const svgW = (gridEndX - gridStartX) * pxPerMeter;
    const svgH = (gridEndY - gridStartY) * pxPerMeter;

    // Vertical grid lines (all gray)
    for (let x = gridStartX; x <= gridEndX + 0.001; x += gridInterval) {
      const px = x * pxPerMeter;
      gridLines.push(
        <line
          key={`v-${x.toFixed(2)}`}
          x1={px}
          y1={svgMinY}
          x2={px}
          y2={svgMinY + svgH}
          stroke="currentColor"
          strokeWidth={gridStrokeWidth}
          strokeDasharray={dragging ? undefined : "2 6"}
          opacity={dragging ? 0.55 : 0.4}
        />,
      );
    }
    // Horizontal grid lines (all gray)
    for (let y = gridStartY; y <= gridEndY + 0.001; y += gridInterval) {
      const py = y * pxPerMeter;
      gridLines.push(
        <line
          key={`h-${y.toFixed(2)}`}
          x1={svgMinX}
          y1={py}
          x2={svgMinX + svgW}
          y2={py}
          stroke="currentColor"
          strokeWidth={gridStrokeWidth}
          strokeDasharray={dragging ? undefined : "2 6"}
          opacity={dragging ? 0.55 : 0.4}
        />,
      );
    }
  }

  // The walls, whether or not the grid shows: turning the grid off took the room's outline with it.
  // Grey, not red — red read as an error on a line that is always there.
  // The Hue cube's +y is the canvas top, so the top wall is always where the screen is.
  const frontWall = outline.find((a, i) => a.y === 0 && outline[(i + 1) % outline.length]!.y === 0);
  const frontLeft = frontWall
    ? Math.min(frontWall.x, outline[(outline.indexOf(frontWall) + 1) % outline.length]!.x)
    : null;
  const wallLines = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    return (
      <line
        key={`wall-${i}`}
        x1={a.x * pxPerMeter}
        y1={a.y * pxPerMeter}
        x2={b.x * pxPerMeter}
        y2={b.y * pxPerMeter}
        stroke="var(--lm-ink-dim)"
        strokeWidth={1.5}
        strokeLinecap="square"
      />
    );
  });

  return (
    <div
      ref={canvasRef}
      data-room-map-viewport=""
      // `select-none` because a drag sweeps bubbled pointer-moves across the
      // `<text>` and chip labels and highlights them. The dock's inputs mount
      // outside this root, so they keep native selection.
      className={`select-none relative w-full h-full overflow-hidden bg-bg ${panMode ? "cursor-grab" : ""}`}
      onClick={handleBackgroundClick}
      onWheel={handleCanvasWheel}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerCancel={handleCanvasPointerUp}
    >
      {/* Object layer with zoom/pan transform (z-index 10+) */}
      <div
        ref={objectLayerRef}
        data-testid="room-map-object-layer"
        data-room-map-object-layer=""
        className="relative z-10 w-full h-full"
        style={{
          transform: layerTransform(panOffset.x, panOffset.y, zoom),
          transformOrigin: "0 0",
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          if (swallowClick.current) {
            swallowClick.current = false;
            return;
          }
          onCanvasClick();
        }}
      >
        {/* Grid SVG — inside object layer so it moves with zoom/pan */}
        {showGrid && canvasSize.w > 0 && (
          <svg
            className="absolute text-zinc-700 pointer-events-none"
            style={{ zIndex: 1, left: 0, top: 0, overflow: "visible" }}
            width={1}
            height={1}
          >
            {gridLines}
          </svg>
        )}

        {/* Above the furniture (10), under strips and lights (20): a piece pushed against a wall
            or into the cut is drawn behind it, as a plan draws walls. */}
        <svg
          className="absolute pointer-events-none"
          style={{ zIndex: 12, left: 0, top: 0, overflow: "visible" }}
          width={1}
          height={1}
          aria-hidden="true"
          data-testid="room-walls"
        >
          {wallLines}
        </svg>

        {frontLeft !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint"
            style={{
              left: frontLeft * pxPerMeter,
              top: 0,
              zIndex: 12,
              transform: `translateY(calc(-100% - 6px / ${zoom})) scale(${1 / zoom})`,
              transformOrigin: "0 100%",
            }}
            data-testid="room-front-wall"
          >
            {t("roomMap:frontWall")}
          </span>
        )}

        {/* What the outline cuts out of the room's box: hatched, so it reads as not the room. */}
        {outline.length > 4 && (
          <svg
            className="absolute pointer-events-none text-ink-faint"
            style={{ zIndex: 11, left: 0, top: 0, overflow: "visible" }}
            width={1}
            height={1}
            aria-hidden="true"
            data-testid="room-outline-cut"
          >
            <defs>
              <pattern id={cutPatternId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.35" />
              </pattern>
            </defs>
            {/* A wash first, so what lies in the cut reads as out of the room, then the hatch. */}
            <path
              fillRule="evenodd"
              style={{ fill: "var(--lm-bg)", opacity: 0.6 }}
              d={`M0 0H${widthMeters * pxPerMeter}V${depthMeters * pxPerMeter}H0Z M${outline
                .map((c) => `${c.x * pxPerMeter} ${c.y * pxPerMeter}`)
                .join(" L")}Z`}
            />
            <path
              fillRule="evenodd"
              fill={`url(#${cutPatternId})`}
              d={`M0 0H${widthMeters * pxPerMeter}V${depthMeters * pxPerMeter}H0Z M${outline
                .map((c) => `${c.x * pxPerMeter} ${c.y * pxPerMeter}`)
                .join(" L")}Z`}
            />
          </svg>
        )}

        {/* Image layers — inside object layer so they follow grid/zoom/pan */}
        {config.imageLayers.map((layer) => (
          <ImageLayerView
            key={layer.id}
            layer={layer}
            zoom={zoom}
            selected={selectedId === imageLayerObjectId(layer.id)}
            panMode={panMode}
            onSelect={onImageLayerSelect}
            onTransformChange={onImageLayerTransformChange}
          />
        ))}

        <SelectionLayerContext.Provider value={selectionLayer}>{children}</SelectionLayerContext.Provider>
        {/* Above every piece: a selected rug keeps its handles while the sofa on it stays on top. */}
        <div ref={setSelectionLayer} className="pointer-events-none absolute inset-0" style={{ zIndex: 40 }} />
      </div>
      {marquee && (
        <div
          className="pointer-events-none absolute z-50 rounded-[3px] border border-amber/70 bg-amber/10"
          style={marquee}
          data-testid="room-marquee"
        />
      )}
    </div>
  );
}
