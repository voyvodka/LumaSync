import React, { useRef, useState, useEffect, useCallback } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { RoomMapConfig, ImageLayer } from "../../../../shared/contracts/roomMap";

type ResizeCorner = "nw" | "ne" | "sw" | "se";

/** Draggable + resizable image layer (lives inside object layer) */
function ImageLayerView({
  layer, zoom, selected, panMode, onSelect, onTransformChange,
}: {
  layer: ImageLayer;
  zoom: number;
  selected?: boolean;
  panMode?: boolean;
  onSelect?: () => void;
  onTransformChange?: (id: string, ox: number, oy: number, s: number, sx?: number, sy?: number) => void;
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
    readFile(layer.path)
      .then((data) => {
        if (revoked) return;
        const ext = layer.path.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
        url = URL.createObjectURL(new Blob([data], { type: mime }));
        setBlobUrl(url);
      })
      .catch(() => { if (!revoked) setBlobUrl(null); });
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

  // --- Drag handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (panMode) return;
    e.stopPropagation();
    onSelect?.();
    if (!canDrag) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: localOx, oy: localOy };
  }, [localOx, localOy, canDrag, panMode, onSelect]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = (e.clientX - dragRef.current.startX) / zoomRef.current;
    const dy = (e.clientY - dragRef.current.startY) / zoomRef.current;
    setLocalOx(dragRef.current.ox + dx);
    setLocalOy(dragRef.current.oy + dy);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
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
  }, [panMode, canDrag, localSx, localSy, localOx, localOy, naturalSize]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r.active) return;
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
      onTransformChange?.(layer.id, localOx, localOy, layer.scale, nsx, nsy);
    } else {
      const nsx = Math.max(0.05, localSx * factor);
      const nsy = Math.max(0.05, localSy * factor);
      setLocalSx(nsx);
      setLocalSy(nsy);
      onTransformChange?.(layer.id, localOx, localOy, layer.scale, nsx, nsy);
    }
  }, [layer.id, layer.scale, localOx, localOy, localSx, localSy, onTransformChange, canDrag, aspectLocked]);

  if (!blobUrl) return null;

  const layerOpacity = (layer.opacity ?? 100) / 100;
  const imgW = naturalSize ? naturalSize.w * localSx : 0;
  const imgH = naturalSize ? naturalSize.h * localSy : 0;

  const CORNER_CLASSES: Record<ResizeCorner, string> = {
    nw: "top-[-4px] left-[-4px] cursor-nwse-resize",
    ne: "top-[-4px] right-[-4px] cursor-nesw-resize",
    sw: "bottom-[-4px] left-[-4px] cursor-nesw-resize",
    se: "bottom-[-4px] right-[-4px] cursor-nwse-resize",
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
      {/* Resize corner handles — same style as Furniture/TV ResizeHandle */}
      {selected && canDrag && naturalSize && cornerKeys.map((key) => (
        <div
          key={key}
          className={`absolute h-2 w-2 rounded-sm border border-slate-900 bg-white dark:border-zinc-100 dark:bg-zinc-950 ${CORNER_CLASSES[key]}`}
          onPointerDown={(e) => handleResizePointerDown(key, e)}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        />
      ))}
    </div>
  );
}

export interface RoomMapContextValue {
  pxPerMeter: number;
  canvasSize: { w: number; h: number };
}

export const RoomMapContext = React.createContext<RoomMapContextValue>({
  pxPerMeter: 100,
  canvasSize: { w: 0, h: 0 },
});

interface RoomMapCanvasProps {
  config: RoomMapConfig;
  pxPerMeter: number;
  showGrid: boolean;
  gridStrokeWidth: number;
  selectedId: string | null;
  onCanvasClick: () => void;
  onImageLayerTransformChange?: (id: string, offsetX: number, offsetY: number, scale: number, scaleX?: number, scaleY?: number) => void;
  onImageLayerSelect?: (id: string) => void;
  zoom?: number;
  panOffset?: { x: number; y: number };
  onZoomChange?: (zoom: number) => void;
  onPanChange?: (offset: { x: number; y: number }) => void;
  panMode?: boolean;
  children?: React.ReactNode;
}

export function RoomMapCanvas({
  config,
  pxPerMeter,
  showGrid,
  gridStrokeWidth,
  selectedId,
  onCanvasClick,
  onImageLayerTransformChange,
  onImageLayerSelect,
  zoom = 1,
  panOffset = { x: 0, y: 0 },
  onZoomChange,
  onPanChange,
  panMode = false,
  children,
}: RoomMapCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    // Initial measurement
    const rect = el.getBoundingClientRect();
    setCanvasSize({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  const { widthMeters, depthMeters } = config.dimensions;

  // Grid interval: 0.5m if room width < 4m, else 1.0m
  const gridInterval = widthMeters < 4 ? 0.5 : 1.0;

  const panRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number }>({
    active: false, startX: 0, startY: 0, ox: 0, oy: 0,
  });
  const spaceRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " && !e.repeat) { spaceRef.current = true; setSpaceHeld(true); e.preventDefault(); }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") { spaceRef.current = false; setSpaceHeld(false); }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => { window.removeEventListener("keydown", handleKeyDown); window.removeEventListener("keyup", handleKeyUp); };
  }, []);

  const handleCanvasWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!onZoomChange || !onPanChange) return;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const next = Math.max(0.3, Math.min(3, zoom + delta));
      // Mouse position relative to canvas element
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) { onZoomChange(next); return; }
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Keep the point under the mouse fixed:
      // Before zoom: worldX = (mx - panX) / oldZoom
      // After zoom:  mx = worldX * newZoom + newPanX
      // => newPanX = mx - (mx - panX) / oldZoom * newZoom
      const newPanX = mx - ((mx - panOffset.x) / zoom) * next;
      const newPanY = my - ((my - panOffset.y) / zoom) * next;
      onZoomChange(next);
      onPanChange({ x: newPanX, y: newPanY });
    },
    [zoom, panOffset, onZoomChange, onPanChange],
  );

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (spaceRef.current || e.button === 1) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        panRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: panOffset.x, oy: panOffset.y };
      }
    },
    [panOffset],
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!panRef.current.active) return;
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      onPanChange?.({ x: panRef.current.ox + dx, y: panRef.current.oy + dy });
    },
    [onPanChange],
  );

  const handleCanvasPointerUp = useCallback(() => {
    panRef.current.active = false;
  }, []);

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
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
  // Extend grid well beyond visible area, aligned to center
  const gridPadM = gridInterval * 2;
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
          strokeDasharray="2 6"
          opacity={0.4}
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
          strokeDasharray="2 6"
          opacity={0.4}
        />,
      );
    }

    // Room boundary walls — solid red lines on top of grid
    const bx0 = 0;
    const bx1 = widthMeters * pxPerMeter;
    const by0 = 0;
    const by1 = depthMeters * pxPerMeter;
    const wallStroke = 1;
    const walls = [
      { key: "wall-top",    x1: bx0, y1: by0, x2: bx1, y2: by0 },
      { key: "wall-bottom", x1: bx0, y1: by1, x2: bx1, y2: by1 },
      { key: "wall-left",   x1: bx0, y1: by0, x2: bx0, y2: by1 },
      { key: "wall-right",  x1: bx1, y1: by0, x2: bx1, y2: by1 },
    ];
    for (const w of walls) {
      gridLines.push(
        <line
          key={w.key}
          x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
          stroke="#f43f5e"
          strokeWidth={wallStroke}
          opacity={0.7}
        />,
      );
    }
  }

  return (
    <RoomMapContext.Provider value={{ pxPerMeter, canvasSize }}>
      <div
        ref={canvasRef}
        className={`relative w-full h-full overflow-hidden bg-slate-100/60 dark:bg-zinc-950 ${spaceHeld ? "cursor-grab" : ""}`}
        onClick={handleBackgroundClick}
        onWheel={handleCanvasWheel}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
      >
        {/* Object layer with zoom/pan transform (z-index 10+) */}
        <div
          className="relative z-10 w-full h-full"
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onCanvasClick();
            }
          }}
        >
          {/* Grid SVG — inside object layer so it moves with zoom/pan */}
          {showGrid && canvasSize.w > 0 && (
            <svg
              className="absolute text-slate-300 dark:text-zinc-800 pointer-events-none"
              style={{ zIndex: 1, left: 0, top: 0, overflow: "visible" }}
              width={1}
              height={1}
            >
              {gridLines}
            </svg>
          )}

          {/* Image layers — inside object layer so they follow grid/zoom/pan */}
          {config.imageLayers.map((layer) => (
            <ImageLayerView
              key={layer.id}
              layer={layer}
              zoom={zoom}
              selected={selectedId === `img-${layer.id}`}
              panMode={panMode}
              onSelect={() => onImageLayerSelect?.(layer.id)}
              onTransformChange={onImageLayerTransformChange}
            />
          ))}

          {children}
        </div>
      </div>
    </RoomMapContext.Provider>
  );
}
