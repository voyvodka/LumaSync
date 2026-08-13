import { useEffect, useRef } from "react";
import React from "react";

export const MouseCoordinateDisplay = React.memo(function MouseCoordinateDisplay({
  canvasContainerRef,
  panOffset,
  pxPerMeter,
  zoom,
  widthMeters,
  depthMeters,
}: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  panOffset: { x: number; y: number };
  pxPerMeter: number;
  zoom: number;
  widthMeters: number;
  depthMeters: number;
}) {
  const displayRef = useRef<HTMLDivElement>(null);

  // Store rapidly changing values in a ref to prevent event listener thrashing on every pan/zoom frame
  const stateRef = useRef({ panOffset, zoom, widthMeters, depthMeters, pxPerMeter });
  stateRef.current = { panOffset, zoom, widthMeters, depthMeters, pxPerMeter };

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;

    let ticking = false;
    let latestEvent: MouseEvent | null = null;

    const updateCoord = () => {
      if (!latestEvent || !displayRef.current) return;
      const rect = el.getBoundingClientRect();
      const { panOffset, pxPerMeter, zoom, widthMeters, depthMeters } = stateRef.current;
      const mx = (latestEvent.clientX - rect.left - panOffset.x) / (pxPerMeter * zoom);
      const my = (latestEvent.clientY - rect.top - panOffset.y) / (pxPerMeter * zoom);

      const worldX = mx - widthMeters / 2;
      const worldY = my - depthMeters / 2;

      displayRef.current.textContent = `x: ${worldX >= 0 ? "+" : ""}${worldX.toFixed(1)}m, y: ${worldY >= 0 ? "+" : ""}${worldY.toFixed(1)}m`;
      displayRef.current.style.display = "block";

      ticking = false;
    };

    const handleMouseMove = (e: MouseEvent) => {
      latestEvent = e;
      if (!ticking) {
        requestAnimationFrame(updateCoord);
        ticking = true;
      }
    };

    const handleMouseLeave = () => {
      latestEvent = null;
      if (displayRef.current) {
        displayRef.current.style.display = "none";
      }
    };

    el.addEventListener("mousemove", handleMouseMove);
    el.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [canvasContainerRef]);

  return (
    <div
      ref={displayRef}
      className="absolute bottom-1 right-1 pointer-events-none z-50 rounded bg-black/60 px-1.5 py-0.5 text-[9px] [font-family:var(--lm-mono)] text-white/80 tabular-nums"
      style={{ display: "none" }}
    />
  );
});
