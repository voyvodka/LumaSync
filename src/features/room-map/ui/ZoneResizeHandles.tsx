import type { HueZone } from "@/shared/contracts/roomMap";

import { rectToZone, resizeZoneRect, ZONE_HANDLES, type ZoneHandle, zoneRect } from "../model/zoneRect";
import { pastSlop } from "./objects/dragIntent";

type Footprint = Pick<HueZone, "centerX" | "centerY" | "scaleX" | "scaleY">;

/**
 * The eight grips on the active zone's bounds box. A drag reshapes the box, its centre marker, its
 * name chip and every light bound to it in place, and writes the zone once on release. Pointer
 * only: the dock's width and depth fields are the keyboard's way.
 */
export function ZoneResizeHandles({
  zone,
  widthM,
  depthM,
  pxPerMeter,
  zoom,
  panMode,
  onResize,
}: {
  zone: HueZone;
  widthM: number;
  depthM: number;
  pxPerMeter: number;
  zoom: number;
  panMode: boolean;
  onResize: (zoneId: string, footprint: Footprint) => void;
}) {
  const begin = (handle: ZoneHandle, e: React.PointerEvent<HTMLSpanElement>) => {
    if (panMode || e.button !== 0) return;
    e.stopPropagation();
    const grip = e.currentTarget;
    const box = grip.parentElement;
    const root = box?.parentElement;
    if (!box || !root) return;
    grip.setPointerCapture(e.pointerId);
    const start = zoneRect(zone, widthM, depthM);
    const startW = Math.max(start.x1 - start.x0, 1e-6);
    const startD = Math.max(start.y1 - start.y0, 1e-6);
    const ppm = pxPerMeter;
    const marker = root.querySelector<HTMLElement>(`[data-zone-center-id="${zone.id}"]`);
    const chip = root.querySelector<HTMLElement>(`[data-zone-chip-id="${zone.id}"]`);
    const lights = Array.from(root.querySelectorAll<HTMLElement>(`[data-zone-channel-id="${zone.id}"]`)).map((el) => ({
      el,
      u: (parseFloat(el.style.left || "0") / ppm - start.x0) / startW,
      v: (parseFloat(el.style.top || "0") / ppm - start.y0) / startD,
    }));
    const saved = [box, marker, chip, ...lights.map((l) => l.el)].map((el) => el && { el, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height });
    let next = start;
    let moved = false;

    const paint = () => {
      box.style.left = `${next.x0 * ppm}px`;
      box.style.top = `${next.y0 * ppm}px`;
      box.style.width = `${(next.x1 - next.x0) * ppm}px`;
      box.style.height = `${(next.y1 - next.y0) * ppm}px`;
      if (marker) {
        marker.style.left = `${((next.x0 + next.x1) / 2) * ppm}px`;
        marker.style.top = `${((next.y0 + next.y1) / 2) * ppm}px`;
      }
      if (chip) {
        chip.style.left = `${Math.max(8 / zoom, next.x0 * ppm + 6 / zoom)}px`;
        chip.style.top = `${Math.max(8 / zoom, next.y0 * ppm - 22 / zoom)}px`;
      }
      for (const { el, u, v } of lights) {
        el.style.left = `${(next.x0 + u * (next.x1 - next.x0)) * ppm}px`;
        el.style.top = `${(next.y0 + v * (next.y1 - next.y0)) * ppm}px`;
      }
    };
    const move = (mv: PointerEvent) => {
      if (!moved && !pastSlop(e.clientX, e.clientY, mv.clientX, mv.clientY)) return;
      moved = true;
      const scale = ppm * zoom;
      next = resizeZoneRect(start, handle, (mv.clientX - e.clientX) / scale, (mv.clientY - e.clientY) / scale, widthM, depthM, mv.shiftKey);
      paint();
    };
    const stop = () => {
      if (grip.hasPointerCapture?.(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
    };
    const restore = () => {
      for (const s of saved) {
        if (!s) continue;
        Object.assign(s.el.style, { left: s.left, top: s.top, width: s.width, height: s.height });
      }
    };
    const up = () => {
      stop();
      if (moved) onResize(zone.id, rectToZone(next, widthM, depthM));
    };
    const cancel = () => {
      stop();
      restore();
    };
    const esc = (kv: KeyboardEvent) => {
      if (kv.key !== "Escape") return;
      kv.preventDefault();
      kv.stopPropagation();
      cancel();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
  };

  return (
    <>
      {ZONE_HANDLES.map((handle) => (
        <span
          key={handle}
          data-zone-handle={handle}
          className="lm-room-zone-grip"
          aria-hidden="true"
          style={{ "--lm-zone-grip-scale": 1 / zoom } as React.CSSProperties}
          onPointerDown={(e) => begin(handle, e)}
          onClick={(e) => e.stopPropagation()}
        />
      ))}
    </>
  );
}
