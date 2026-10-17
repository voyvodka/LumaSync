import { memo, useRef, useState } from "react";

import type { LightStructure } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";

import { decorLightObjectId } from "../../model/objectId";
import styles from "./DecorLightObject.module.css";
import { markDragging, stillAClick, useEscapeCancels } from "./dragIntent";

const MARK_M = 0.14;
/** Around the mark, so a small one at a low zoom is still a target. */
const HIT_PAD_PX = 6;

export const DecorLightObject = memo(function DecorLightObject({
  light,
  name,
  pxPerMeter,
  zoom,
  roomWidth,
  roomDepth,
  selected,
  panMode,
  onSelect,
  onMove,
}: {
  light: LightStructure;
  name: string;
  pxPerMeter: number;
  zoom: number;
  roomWidth: number;
  roomDepth: number;
  selected: boolean;
  panMode: boolean;
  onSelect: (objectId: string, additive: boolean) => void;
  onMove: (objectId: string, x: number, y: number) => void;
}) {
  const id = decorLightObjectId(light.id);
  const [carried, setCarried] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef({ active: false, startClientX: 0, startClientY: 0 });
  const element = useRef<HTMLDivElement | null>(null);

  const target = (clientX: number, clientY: number) => {
    const ppm = pxPerMeter * zoom;
    return {
      x: Math.min(Math.max(light.x + (clientX - drag.current.startClientX) / ppm, 0), roomWidth),
      y: Math.min(Math.max(light.y + (clientY - drag.current.startClientY) / ppm, 0), roomDepth),
    };
  };
  const finish = (commit: { clientX: number; clientY: number } | null) => {
    if (!drag.current.active) return;
    drag.current.active = false;
    const moved = !!element.current?.hasAttribute("data-dragging");
    markDragging(element.current, false);
    setCarried(null);
    if (!commit || !moved) return;
    const next = target(commit.clientX, commit.clientY);
    const x = Math.round(next.x * 100) / 100;
    const y = Math.round(next.y * 100) / 100;
    if (x !== light.x || y !== light.y) onMove(id, x, y);
  };
  useEscapeCancels(
    () => drag.current.active,
    () => finish(null),
  );

  const at = carried ?? light;
  const r = MARK_M * pxPerMeter;
  const half = r + HIT_PAD_PX;
  const arm = r * 0.7;
  return (
    <div
      ref={element}
      className={cx(styles.light, light.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing")}
      data-object-id={id}
      data-selected={selected || undefined}
      style={{ left: at.x * pxPerMeter - half, top: at.y * pxPerMeter - half, width: half * 2, height: half * 2 }}
      onPointerDown={(e) => {
        if (panMode) return;
        onSelect(id, e.shiftKey);
        if (light.locked || e.shiftKey) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { active: true, startClientX: e.clientX, startClientY: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!drag.current.active) return;
        if (stillAClick(element.current, drag.current.startClientX, drag.current.startClientY, e.clientX, e.clientY)) return;
        markDragging(element.current, true);
        setCarried(target(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => finish({ clientX: e.clientX, clientY: e.clientY })}
      onPointerCancel={() => finish(null)}
      onLostPointerCapture={() => finish(null)}
    >
      <svg className={styles.mark} width={half * 2} height={half * 2} aria-hidden="true">
        <circle cx={half} cy={half} r={r} />
        <path d={`M${half - arm} ${half - arm} L${half + arm} ${half + arm} M${half + arm} ${half - arm} L${half - arm} ${half + arm}`} />
      </svg>
      <span className={styles.label}>{name}</span>
    </div>
  );
});
