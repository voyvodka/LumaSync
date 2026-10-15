import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_STRIP_CORNERS, type RoomCorner, resolveStripCorners, stripRunLength, translateStrip, type UsbStripPlacement } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";
import { usbStripObjectId } from "../../model/objectId";
import { keepStripInside, type RoomBox } from "../../model/pieceGeometry";
import { addStripCorner, pointAlongStrip, removeStripCorner } from "../../model/stripCorners";
import { markDragging, stillAClick, useEscapeCancels } from "./dragIntent";

interface UsbStripObjectProps {
  placement: UsbStripPlacement;
  pxPerMeter: number;
  selected: boolean;
  zoom?: number;
  panMode?: boolean;
  /**
   * Live connection status the canvas badge consumes.
   * `connected` ⇒ green ONLINE chip beside the start handle,
   * `disconnected` ⇒ red OFFLINE chip,
   * `unknown` (default) ⇒ no chip rendered, so legacy maps stay clean
   *  before the parent has read the local-output registry.
   */
  connectionStatus?: "connected" | "disconnected" | "unknown";
  /** The room's box: a drag keeps both ends inside it. */
  room?: RoomBox;
  /** Whether a double-click may bend it: the TV's backlight is drawn at the screen and stays straight. */
  bendable?: boolean;
  onSelect: (id: string) => void;
  /** `continuous` marks the LED-count field, which writes per keystroke. */
  onChange: (updated: UsbStripPlacement, continuous?: boolean) => void;
}

/** The whole strip, or one of its points: 0 its start, the last its end, the corners between. */
type HandleType = "line" | number;

/** Snap threshold in metres — if difference is within this, snap to axis */
const AXIS_SNAP_M = 0.15;

const sameCorners = (a: readonly RoomCorner[], b: readonly RoomCorner[]) =>
  a.length === b.length && a.every((c, i) => c.x === b[i]!.x && c.y === b[i]!.y);

export const UsbStripObject = memo(function UsbStripObject({
  placement,
  pxPerMeter,
  selected,
  zoom = 1,
  panMode = false,
  connectionStatus = "unknown",
  room,
  bendable = true,
  onSelect,
  onChange,
}: UsbStripObjectProps) {
  const { t } = useTranslation();

  // The strip as drawn while a drag is under way; it is the placement at rest.
  const [local, setLocal] = useState(placement);
  const [localLedCount, setLocalLedCount] = useState(placement.ledCount);
  const [axisSnap, setAxisSnap] = useState<{ axis: "h" | "v"; point: number } | null>(null);

  const prevPlacement = useRef(placement);
  if (prevPlacement.current !== placement) {
    prevPlacement.current = placement;
    setLocal(placement);
    setLocalLedCount(placement.ledCount);
  }

  const corners = resolveStripCorners(local);
  const points: RoomCorner[] = [{ x: local.startX, y: local.startY }, ...corners, { x: local.endX, y: local.endY }];
  const last = points.length - 1;

  const dragRef = useRef<{
    active: boolean;
    handle: HandleType | null;
    startClientX: number;
    startClientY: number;
    from: UsbStripPlacement;
  }>({ active: false, handle: null, startClientX: 0, startClientY: 0, from: placement });

  const withPoint = (strip: UsbStripPlacement, index: number, p: RoomCorner): UsbStripPlacement => {
    if (index === 0) return { ...strip, startX: p.x, startY: p.y };
    if (index === last) return { ...strip, endX: p.x, endY: p.y };
    const next = [...resolveStripCorners(strip)];
    next[index - 1] = p;
    return { ...strip, corners: next };
  };

  /** A dragged point snaps level with, or plumb under, the point either side of it. */
  const snapPoint = (p: RoomCorner, neighbours: readonly RoomCorner[]): { p: RoomCorner; snap: "h" | "v" | null } => {
    for (const n of neighbours) if (Math.abs(p.y - n.y) < AXIS_SNAP_M) return { p: { x: p.x, y: n.y }, snap: "h" };
    for (const n of neighbours) if (Math.abs(p.x - n.x) < AXIS_SNAP_M) return { p: { x: n.x, y: p.y }, snap: "v" };
    return { p, snap: null };
  };

  const handlePointerDown = (
    e: React.PointerEvent<HTMLDivElement | SVGLineElement>,
    handle: HandleType,
  ) => {
    if (panMode) return;
    e.stopPropagation();
    onSelect(placement.stripId);
    if (placement.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, handle, startClientX: e.clientX, startClientY: e.clientY, from: local };
    grabbedRef.current = e.currentTarget;
  };
  const grabbedRef = useRef<Element | null>(null);
  const clampPoint = (x: number, y: number) =>
    room ? { x: clamp(x, 0, room.width), y: clamp(y, 0, room.depth) } : { x, y };

  const cancelDrag = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    markDragging(grabbedRef.current, false);
    setAxisSnap(null);
    setLocal(placement);
  };
  useEscapeCancels(() => dragRef.current.active, cancelDrag);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement | SVGLineElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.handle === null) return;
    if (stillAClick(grabbedRef.current, drag.startClientX, drag.startClientY, e.clientX, e.clientY)) return;
    markDragging(grabbedRef.current, true);
    const effectivePpm = pxPerMeter * zoom;
    const dx = (e.clientX - drag.startClientX) / effectivePpm;
    const dy = (e.clientY - drag.startClientY) / effectivePpm;

    if (drag.handle === "line") {
      const moved = translateStrip(drag.from, dx, dy);
      setLocal(room ? keepStripInside(moved, room) : moved);
      setAxisSnap(null);
      return;
    }
    const index = drag.handle;
    const from = [{ x: drag.from.startX, y: drag.from.startY }, ...resolveStripCorners(drag.from), { x: drag.from.endX, y: drag.from.endY }];
    const origin = from[index]!;
    const neighbours = [from[index - 1], from[index + 1]].filter((n): n is RoomCorner => n !== undefined);
    const snapped = snapPoint(clampPoint(origin.x + dx, origin.y + dy), neighbours);
    setLocal(withPoint(drag.from, index, snapped.p));
    setAxisSnap(snapped.snap ? { axis: snapped.snap, point: index } : null);
  };

  const handlePointerUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    markDragging(grabbedRef.current, false);
    setAxisSnap(null);
    const movedCorners = !sameCorners(corners, resolveStripCorners(placement));
    if (
      movedCorners ||
      local.startX !== placement.startX ||
      local.startY !== placement.startY ||
      local.endX !== placement.endX ||
      local.endY !== placement.endY
    ) {
      onChange({
        ...placement,
        startX: local.startX,
        startY: local.startY,
        endX: local.endX,
        endY: local.endY,
        ...(movedCorners ? { corners } : {}),
      });
    }
  };

  /** A double-click on the line bends it there; one on a corner straightens it out again. */
  const handleLineDoubleClick = (e: React.MouseEvent<SVGLineElement>, leg: number) => {
    e.stopPropagation();
    if (placement.locked || panMode) return;
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const effectivePpm = pxPerMeter * zoom;
    const at = box ? { x: (e.clientX - box.left) / effectivePpm, y: (e.clientY - box.top) / effectivePpm } : undefined;
    const bent = addStripCorner(placement, leg, at);
    if (bent) onChange(bent);
  };
  const handleCornerDoubleClick = (e: React.MouseEvent, corner: number) => {
    e.stopPropagation();
    if (placement.locked || panMode) return;
    onChange(removeStripCorner(placement, corner));
  };

  // The strip as it was when the LED count field took focus. Each keystroke refits a strip of known
  // density, and refit from the last keystroke's strip, clearing the field to retype cut a bent strip
  // to a centimetre and dropped every corner past it for good.
  const typingFrom = useRef<UsbStripPlacement | null>(null);
  const handleLedCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    const clamped = isNaN(val) ? 1 : clamp(val, 1, 1000);
    setLocalLedCount(clamped);
    onChange({ ...(typingFrom.current ?? placement), ledCount: clamped }, true);
  };

  const px = points.map((p) => ({ x: p.x * pxPerMeter, y: p.y * pxPerMeter }));
  const sx = px[0]!.x;
  const sy = px[0]!.y;
  const ex = px[last]!.x;
  const ey = px[last]!.y;
  const polyline = px.map((p) => `${p.x},${p.y}`).join(" ");

  // The arrow points the way the last leg runs.
  const angle = Math.atan2(ey - px[last - 1]!.y, ex - px[last - 1]!.x) * (180 / Math.PI);

  // The LED count sits halfway along the run, which is on a leg even when the strip is bent.
  const middle = pointAlongStrip(local, stripRunLength(local) / 2);
  const midX = middle.x * pxPerMeter;
  const midY = middle.y * pxPerMeter;
  const canBend = bendable && !placement.locked && corners.length < MAX_STRIP_CORNERS;

  return (
    <>
      {/* SVG line + arrow + invisible wide hit area for line drag */}
      <svg
        data-object-id={usbStripObjectId(placement.stripId)}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 1, pointerEvents: "none", overflow: "visible" }}
      >
        {/* Invisible wide stroke per leg for easier line grab (pointer-events: stroke) */}
        {px.slice(1).map((b, leg) => (
          <line
            key={leg}
            x1={px[leg]!.x}
            y1={px[leg]!.y}
            x2={b.x}
            y2={b.y}
            stroke="transparent"
            strokeWidth="14"
            style={{ cursor: selected ? "grab" : "pointer", pointerEvents: "visibleStroke" }}
            onPointerDown={(e) => handlePointerDown(e, "line")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(placement.stripId);
            }}
            onDoubleClick={canBend ? (e) => handleLineDoubleClick(e, leg) : undefined}
          />
        ))}
        {/* Visible dashed line */}
        <polyline
          points={polyline}
          fill="none"
          strokeLinejoin="round"
          stroke={selected ? (placement.locked ? "rgba(255,255,255,0.4)" : "#ffffff") : "#06b6d4"}
          strokeWidth={selected ? 2.5 : 2}
          strokeDasharray="4 4"
          style={{ pointerEvents: "none" }}
        />
        <polygon
          points="0,-6 5,0 -5,0"
          fill="#06b6d4"
          transform={`translate(${ex}, ${ey}) rotate(${angle + 90})`}
          style={{ pointerEvents: "none" }}
        />
        {/* Axis snap guide line — shown while dragging endpoint near horizontal/vertical */}
        {axisSnap?.axis === "h" && (
          <>
            <line
              x1={0} y1={px[axisSnap.point]!.y} x2="100%" y2={px[axisSnap.point]!.y}
              stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 3" opacity={0.6}
              style={{ pointerEvents: "none" }}
            />
            <text
              x={px[axisSnap.point]!.x + 8} y={px[axisSnap.point]!.y - 6}
              fill="#22d3ee" fontSize="9" fontWeight="bold" opacity={0.9}
              style={{ pointerEvents: "none" }}
            >
              H
            </text>
          </>
        )}
        {axisSnap?.axis === "v" && (
          <>
            <line
              x1={px[axisSnap.point]!.x} y1={0} x2={px[axisSnap.point]!.x} y2="100%"
              stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 3" opacity={0.6}
              style={{ pointerEvents: "none" }}
            />
            <text
              x={px[axisSnap.point]!.x + 6} y={px[axisSnap.point]!.y - 12}
              fill="#22d3ee" fontSize="9" fontWeight="bold" opacity={0.9}
              style={{ pointerEvents: "none" }}
            >
              V
            </text>
          </>
        )}
      </svg>

      {/* Connection status badge + multi-strip
          port label anchored above the start handle. The port label
          renders whenever the strip carries a persisted `portName`
          (a contract field); the live status chip overlays the
          existing badge palette. */}
      {connectionStatus !== "unknown" ? (
        <div
          className={`lm-room-usb-status-badge lm-room-usb-status-badge--${connectionStatus}`}
          style={{
            left: sx - 32,
            top: sy - 22,
          }}
          aria-hidden
        >
          <span className="lm-room-usb-status-badge-dot" aria-hidden />
          <span>
            {connectionStatus === "connected"
              ? t("roomMap:usbStrip.online")
              : t("roomMap:usbStrip.offline")}
          </span>
        </div>
      ) : null}
      {placement.portName ? (
        <div
          className="lm-room-usb-port-label"
          style={{
            left: sx - 32,
            top: sy - 38,
          }}
          aria-hidden
          title={placement.portName}
        >
          {placement.portName}
        </div>
      ) : null}

      {/* Start handle */}
      <div
        className={`absolute rounded-full cursor-grab active:cursor-grabbing ${
          selected
            ? "bg-white ring-2 ring-white/50"
            : "bg-cyan-500 ring-2 ring-zinc-950"
        }`}
        style={{
          width: 12,
          height: 12,
          left: sx - 6,
          top: sy - 6,
          zIndex: 20,
          touchAction: "none",
        }}
        onPointerDown={(e) => handlePointerDown(e, 0)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      />

      {/* End handle */}
      <div
        className={`absolute rounded-full cursor-grab active:cursor-grabbing ${
          selected
            ? "bg-white ring-2 ring-white/50"
            : "bg-cyan-500 ring-2 ring-zinc-950"
        }`}
        style={{
          width: 12,
          height: 12,
          left: ex - 6,
          top: ey - 6,
          zIndex: 20,
          touchAction: "none",
        }}
        onPointerDown={(e) => handlePointerDown(e, last)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
          onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      />

      {/* Corner handles, where the strip turns; shown once it is picked */}
      {selected &&
        px.slice(1, last).map((p, i) => (
          <div
            key={i}
            data-strip-corner={i}
            className="absolute rounded-sm cursor-grab active:cursor-grabbing bg-white ring-2 ring-zinc-950"
            style={{ width: 10, height: 10, left: p.x - 5, top: p.y - 5, zIndex: 20, touchAction: "none" }}
            onPointerDown={(e) => handlePointerDown(e, i + 1)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onDoubleClick={(e) => handleCornerDoubleClick(e, i)}
          />
        ))}

      {/* LED count input shown when selected */}
      {selected && (
        <div
          className="absolute z-30 flex items-center gap-1 rounded border border-amber-500 bg-zinc-900 px-1.5 py-0.5 shadow"
          style={{
            left: midX - 48,
            top: midY - 20,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <label className="text-[10px] text-zinc-400 whitespace-nowrap">
            {t("roomMap:usbStrip.ledCount")}
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            value={localLedCount}
            onChange={handleLedCountChange}
            onFocus={() => {
              typingFrom.current = placement;
            }}
            onBlur={() => {
              typingFrom.current = null;
            }}
            className="w-14 rounded border border-zinc-700 bg-transparent px-1 text-[10px] text-zinc-100 focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
});
