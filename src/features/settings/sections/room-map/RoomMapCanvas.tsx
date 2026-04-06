import React, { useRef, useState, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";

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
  backgroundOpacity: number;
  selectedId: string | null;
  onCanvasClick: () => void;
  children?: React.ReactNode;
}

export function RoomMapCanvas({
  config,
  showGrid,
  backgroundOpacity,
  onCanvasClick,
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
          strokeWidth="0.5"
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
          strokeWidth="0.5"
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
        {/* Background image layer (z-index 0) */}
        {config.backgroundImagePath && (
          <img
            src={convertFileSrc(config.backgroundImagePath)}
            alt="Floor plan"
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            style={{ opacity: backgroundOpacity / 100, zIndex: 0 }}
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
        <div className="relative z-10 w-full h-full">
          {children}
        </div>
      </div>
    </RoomMapContext.Provider>
  );
}
