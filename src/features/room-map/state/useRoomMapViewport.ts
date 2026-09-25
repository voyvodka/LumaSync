import { useCallback, useEffect, useRef, useState } from "react";
import type { RefCallback } from "react";
import type { RoomDimensions } from "@/shared/contracts/roomMap";
import { isEditableTarget } from "@/shared/lib/editableTarget";

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
  /** Arrow-key panning for the canvas. Returns true when the key was consumed. */
  handleArrowPan: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
}

/** Screen pixels per arrow press. Deliberately a screen distance, not a world
 *  distance: a metre-based step would crawl at 0.3× zoom and fly at 3×. */
export const PAN_STEP_PX = 32;
export const PAN_STEP_LARGE_PX = 160;

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

  // Space held is pan mode, for the editor and its canvas alike. A space typed
  // into a field is text, not a pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== " " || isEditableTarget(e.target)) return;
      // Keeps the page from scrolling under a pan.
      e.preventDefault();
      if (!e.repeat) setSpaceHeld(true);
    };
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
      resetViewportScroll(canvasContainerRef.current);
    },
    [canvasSize, widthMeters, depthMeters],
  );

  // Arrows move the camera, not the map — ArrowRight reveals what is to the
  // right, so the offset decreases. This is the opposite sign from space+drag,
  // where the user grabs the map itself.
  const handleArrowPan = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let dx = 0;
    let dy = 0;
    const step = e.shiftKey ? PAN_STEP_LARGE_PX : PAN_STEP_PX;
    if (e.key === "ArrowLeft") dx = step;
    else if (e.key === "ArrowRight") dx = -step;
    else if (e.key === "ArrowUp") dy = step;
    else if (e.key === "ArrowDown") dy = -step;
    else return false;

    e.preventDefault();
    setPanOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    return true;
  }, []);

  const initialFitDone = useRef(false);

  // Live, read once at the fit. Snapshotting at first render framed the 5×4
  // placeholder every time — the persisted config lands a commit later, and
  // `initialFitDone` is what stops a re-fit, not a stale ref.
  const liveDimensionsRef = useRef(dimensions);
  liveDimensionsRef.current = dimensions;

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
          const { widthMeters: wm, depthMeters: dm } = liveDimensionsRef.current;
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
    handleArrowPan,
  };
}

/** Marks the canvas's clipping root, which `fitToView` scrolls back to zero. */
export const ROOM_MAP_VIEWPORT_ATTR = "data-room-map-viewport";

/**
 * The canvas clips with `overflow: hidden`, which still scrolls when the
 * browser brings a focused element into view, and nothing scrolls it back —
 * pan and zoom are a transform, so the map stays shifted by that offset. Fit
 * is the one "put the view back" gesture, so it clears any such scroll too.
 */
export function resetViewportScroll(container: HTMLElement | null): void {
  if (!container) return;
  const targets = [container, ...container.querySelectorAll<HTMLElement>(`[${ROOM_MAP_VIEWPORT_ATTR}]`)];
  for (const el of targets) {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
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
