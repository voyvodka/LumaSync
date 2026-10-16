import { type CSSProperties, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { CLICK_SLOP_PX } from "../model/snapGeometry";
import { clickedZoneRect, drawnZoneRect, type ZoneRect } from "../model/zoneRect";
import styles from "./ZoneDrawLayer.module.css";

/** Over the plan while a zone is being added: a drag draws it, a click drops the default size. */
export function ZoneDrawLayer({
  widthM,
  depthM,
  pxPerMeter,
  zoom,
  colour,
  onDraw,
  onCancel,
}: {
  widthM: number;
  depthM: number;
  pxPerMeter: number;
  zoom: number;
  colour: string;
  onDraw: (rect: ZoneRect) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const metres = new Intl.NumberFormat(i18n?.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef<HTMLSpanElement | null>(null);
  const press = useRef<{ x: number; y: number; clientX: number; clientY: number; moved: boolean } | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Ahead of the editor's own Escape, which would also drop the selection.
      e.preventDefault();
      e.stopPropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const metresAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * widthM, y: ((e.clientY - r.top) / r.height) * depthM };
  };

  const paint = (rect: ZoneRect | null) => {
    const box = boxRef.current;
    if (!box) return;
    box.hidden = rect === null;
    if (!rect) return;
    box.style.left = `${rect.x0 * pxPerMeter}px`;
    box.style.top = `${rect.y0 * pxPerMeter}px`;
    box.style.width = `${(rect.x1 - rect.x0) * pxPerMeter}px`;
    box.style.height = `${(rect.y1 - rect.y0) * pxPerMeter}px`;
    if (sizeRef.current) {
      sizeRef.current.textContent = t("roomMap:hueZones.drawSize", { w: metres.format(rect.x1 - rect.x0), d: metres.format(rect.y1 - rect.y0) });
    }
  };

  return (
    <div
      className={styles.layer}
      data-testid="zone-draw-layer"
      style={{ width: widthM * pxPerMeter, height: depthM * pxPerMeter, "--draw-colour": colour, "--draw-scale": 1 / zoom } as CSSProperties}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { ...metresAt(e), clientX: e.clientX, clientY: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p) return;
        if (!p.moved && Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY) < CLICK_SLOP_PX) return;
        p.moved = true;
        paint(drawnZoneRect(p, metresAt(e), widthM, depthM, e.shiftKey));
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (!p) return;
        paint(null);
        onDraw(p.moved ? drawnZoneRect(p, metresAt(e), widthM, depthM, e.shiftKey) : clickedZoneRect(p, widthM, depthM));
      }}
      onPointerCancel={() => {
        press.current = null;
        paint(null);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={boxRef} className={styles.box} hidden aria-hidden="true">
        <span ref={sizeRef} className={styles.size} />
      </div>
    </div>
  );
}
