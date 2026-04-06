import React, { useRef, useState, useEffect, useCallback } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";

/** Draggable + scroll-to-zoom background image */
function BackgroundImage({
  src, opacity, offsetX, offsetY, scale, onTransformChange,
}: {
  src: string;
  opacity: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  onTransformChange?: (ox: number, oy: number, s: number) => void;
}) {
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number }>({
    active: false, startX: 0, startY: 0, ox: 0, oy: 0,
  });
  const [localOx, setLocalOx] = useState(offsetX);
  const [localOy, setLocalOy] = useState(offsetY);
  const [localScale, setLocalScale] = useState(scale);

  const prevProps = useRef({ offsetX, offsetY, scale });
  if (prevProps.current.offsetX !== offsetX || prevProps.current.offsetY !== offsetY || prevProps.current.scale !== scale) {
    prevProps.current = { offsetX, offsetY, scale };
    setLocalOx(offsetX);
    setLocalOy(offsetY);
    setLocalScale(scale);
  }

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: localOx, oy: localOy };
  }, [localOx, localOy]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLImageElement>) => {
    if (!dragRef.current.active) return;
    setLocalOx(dragRef.current.ox + (e.clientX - dragRef.current.startX));
    setLocalOy(dragRef.current.oy + (e.clientY - dragRef.current.startY));
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    onTransformChange?.(localOx, localOy, localScale);
  }, [localOx, localOy, localScale, onTransformChange]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    const next = Math.max(0.1, Math.min(5, localScale + delta));
    setLocalScale(next);
    onTransformChange?.(localOx, localOy, next);
  }, [localOx, localOy, localScale, onTransformChange]);

  return (
    <img
      src={src}
      alt="Floor plan"
      className="absolute cursor-grab active:cursor-grabbing select-none"
      draggable={false}
      style={{
        opacity,
        zIndex: 2,
        transform: `translate(${localOx}px, ${localOy}px) scale(${localScale})`,
        transformOrigin: "top left",
        maxWidth: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    />
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
  showGrid: boolean;
  gridStrokeWidth: number;
  backgroundOpacity: number;
  selectedId: string | null;
  onCanvasClick: () => void;
  onBackgroundTransformChange?: (offsetX: number, offsetY: number, scale: number) => void;
  children?: React.ReactNode;
}

export function RoomMapCanvas({
  config,
  showGrid,
  gridStrokeWidth,
  backgroundOpacity,
  onCanvasClick,
  onBackgroundTransformChange,
  children,
}: RoomMapCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [bgBlobUrl, setBgBlobUrl] = useState<string | null>(null);

  // Read background image file and create blob URL
  useEffect(() => {
    if (!config.backgroundImagePath) {
      setBgBlobUrl(null);
      return;
    }
    let revoked = false;
    let url: string | null = null;
    readFile(config.backgroundImagePath)
      .then((data) => {
        if (revoked) return;
        const ext = config.backgroundImagePath!.split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
        const blob = new Blob([data], { type: mime });
        url = URL.createObjectURL(blob);
        setBgBlobUrl(url);
      })
      .catch(() => {
        if (!revoked) setBgBlobUrl(null);
      });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [config.backgroundImagePath]);

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

  // Guard against division by zero
  const pxPerMeter =
    canvasSize.w > 0 && canvasSize.h > 0
      ? Math.min(canvasSize.w / widthMeters, canvasSize.h / depthMeters)
      : 100;

  // Grid interval: 0.5m if room width < 4m, else 1.0m
  const gridInterval = widthMeters < 4 ? 0.5 : 1.0;

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onCanvasClick();
      }
    },
    [onCanvasClick],
  );

  const gridLines: React.ReactNode[] = [];
  if (showGrid && canvasSize.w > 0) {
    // Vertical lines
    for (let x = 0; x <= widthMeters + 0.001; x += gridInterval) {
      const px = x * pxPerMeter;
      gridLines.push(
        <line
          key={`v-${x}`}
          x1={px}
          y1={0}
          x2={px}
          y2={canvasSize.h}
          stroke="currentColor"
          strokeWidth={gridStrokeWidth}
          strokeDasharray="2 6"
        />,
      );
    }
    // Horizontal lines
    for (let y = 0; y <= depthMeters + 0.001; y += gridInterval) {
      const py = y * pxPerMeter;
      gridLines.push(
        <line
          key={`h-${y}`}
          x1={0}
          y1={py}
          x2={canvasSize.w}
          y2={py}
          stroke="currentColor"
          strokeWidth={gridStrokeWidth}
          strokeDasharray="2 6"
        />,
      );
    }
  }

  return (
    <RoomMapContext.Provider value={{ pxPerMeter, canvasSize }}>
      <div
        ref={canvasRef}
        className="relative w-full h-full overflow-hidden bg-slate-100/60 dark:bg-zinc-950"
        onClick={handleBackgroundClick}
      >
        {/* Background image layer (z-index 0) — draggable, scroll to resize */}
        {bgBlobUrl && (
          <BackgroundImage
            src={bgBlobUrl}
            opacity={backgroundOpacity / 100}
            offsetX={config.backgroundOffsetX ?? 0}
            offsetY={config.backgroundOffsetY ?? 0}
            scale={config.backgroundScale ?? 1}
            onTransformChange={onBackgroundTransformChange}
          />
        )}

        {/* Grid SVG layer (z-index 1) */}
        {showGrid && canvasSize.w > 0 && (
          <svg
            className="absolute inset-0 w-full h-full text-slate-200 dark:text-zinc-800 pointer-events-none"
            style={{ zIndex: 1 }}
            width={canvasSize.w}
            height={canvasSize.h}
          >
            {gridLines}
          </svg>
        )}

        {/* Object layer (z-index 10+) */}
        <div
          className="relative z-10 w-full h-full"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onCanvasClick();
            }
          }}
        >
          {children}
        </div>
      </div>
    </RoomMapContext.Provider>
  );
}
