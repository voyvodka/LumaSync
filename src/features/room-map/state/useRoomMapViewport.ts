import { useCallback, useEffect, useRef, useState } from "react";
import type { RefCallback } from "react";
import type { RoomDimensions } from "@/shared/contracts/roomMap";

/** Fixed physical scale — objects always render at this size regardless of canvas. */
export const ROOM_MAP_PX_PER_METER = 80;

export interface UseRoomMapViewportReturn {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the canvas container's `ref` — plain reads go through `canvasContainerRef`. */
  setCanvasContainer: RefCallback<HTMLDivElement>;
  canvasSize: { w: number; h: number };
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  panOffset: { x: number; y: number };
  setPanOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  /** True while space is held — suppresses object drag so the canvas pans instead. */
  spaceHeld: boolean;
  /** Zoom + centre the room inside the measured canvas, leaving `pad` px of margin. */
  fitToView: (pad: number) => void;
}

export function useRoomMapViewport(dimensions: RoomDimensions): UseRoomMapViewportReturn {
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);

  const setCanvasContainer = useCallback<RefCallback<HTMLDivElement>>((el) => {
    canvasContainerRef.current = el;
    setCanvasEl(el);
  }, []);

  // Track space key for pan mode — prevents object drag during space+click
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === " " && !e.repeat) setSpaceHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const { widthMeters, depthMeters } = dimensions;

  const fitToView = useCallback(
    (pad: number) => {
      const fit = computeFit(canvasSize.w, canvasSize.h, widthMeters, depthMeters, pad);
      setZoom(fit.zoom);
      setPanOffset(fit.panOffset);
    },
    [canvasSize, widthMeters, depthMeters],
  );

  const initialFitDone = useRef(false);

  // Snapshotted at first render on purpose: the one-shot fit must frame the
  // dimensions the editor started with. Reading the live value would re-fit the
  // view out from under a user who is editing the room size.
  const initialDimensionsRef = useRef(dimensions);

  // Keyed on the element, not on mount: the editor renders a loading placeholder
  // first, so the container appears a commit or two late and a mount-only effect
  // would observe nothing. `initialFitDone` is what keeps the fit one-shot.
  useEffect(() => {
    if (!canvasEl) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) return;
        setCanvasSize({ w: width, h: height });

        if (!initialFitDone.current) {
          initialFitDone.current = true;
          const { widthMeters: wm, depthMeters: dm } = initialDimensionsRef.current;
          const fit = computeFit(width, height, wm, dm, 24);
          setZoom(fit.zoom);
          setPanOffset(fit.panOffset);
        }
      }
    });
    ro.observe(canvasEl);
    return () => ro.disconnect();
  }, [canvasEl]);

  return {
    canvasContainerRef,
    setCanvasContainer,
    canvasSize,
    zoom,
    setZoom,
    panOffset,
    setPanOffset,
    spaceHeld,
    fitToView,
  };
}

/** Exported for tests: measuring the canvas needs a layout engine, computing the
 *  fit from a measurement does not, and this is where the proportion is decided. */
export function computeFit(
  canvasW: number,
  canvasH: number,
  widthMeters: number,
  depthMeters: number,
  pad: number,
): { zoom: number; panOffset: { x: number; y: number } } {
  const fitZoom = Math.min(
    (canvasW - pad * 2) / (widthMeters * ROOM_MAP_PX_PER_METER),
    (canvasH - pad * 2) / (depthMeters * ROOM_MAP_PX_PER_METER),
  );
  const zoom = Math.max(0.3, Math.min(3, fitZoom));
  const roomW = widthMeters * ROOM_MAP_PX_PER_METER * zoom;
  const roomH = depthMeters * ROOM_MAP_PX_PER_METER * zoom;
  return { zoom, panOffset: { x: (canvasW - roomW) / 2, y: (canvasH - roomH) / 2 } };
}
