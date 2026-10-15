import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/lib/cx";

import styles from "./SelectionFrame.module.css";
import { useSelectionLayer } from "./selectionLayer";

/** A side or corner of the frame: which way its handle grows the piece, in the piece's own axes. */
export type FrameHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const FRAME_HANDLES: readonly FrameHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** −1, 0 or +1 along the piece's width (x) and depth (y) for a handle. */
export function handleSigns(handle: FrameHandle): { sx: -1 | 0 | 1; sy: -1 | 0 | 1 } {
  return {
    sx: handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0,
    sy: handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0,
  };
}

const CURSOR: Record<FrameHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/** The rotation a pointer at (`dx`, `dy`) from the centre asks for: the knob sits at the front, up. */
export function rotationToward(dx: number, dy: number, free: boolean): number {
  const raw = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  const step = free ? 1 : 15;
  return (((Math.round(raw / step) * step) % 360) + 360) % 360;
}

interface SelectionFrameProps {
  /** The piece's box on the plan, in object-layer pixels, before its rotation. */
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  /** What the frame names, upright whatever the piece's rotation. */
  label?: string;
  editable: boolean;
  /** The plan's zoom: the handles keep their size on screen. */
  zoom: number;
  onResizeStart: (handle: FrameHandle) => void;
  /** The pointer's travel since the press, in screen pixels. */
  onResizeMove: (handle: FrameHandle, dx: number, dy: number, keepRatio: boolean) => void;
  onResizeEnd: () => void;
  onRotateStart: () => void;
  onRotateMove: (rotation: number) => void;
  onRotateEnd: () => void;
}

/**
 * The selected piece's frame, drawn in the plan's top layer so a rug under a sofa keeps its handles:
 * eight handles that grow it from a side or a corner, and a knob at its front that turns it in 15°
 * steps (⇧ for any angle) and says which way it faces.
 */
export function SelectionFrame({
  left,
  top,
  width,
  height,
  rotation,
  label,
  editable,
  zoom,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onRotateStart,
  onRotateMove,
  onRotateEnd,
}: SelectionFrameProps) {
  const { t } = useTranslation();
  const layer = useSelectionLayer();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{ kind: "resize" | "rotate"; handle?: FrameHandle; x: number; y: number } | null>(null);
  if (!layer) return null;

  const begin = (event: ReactPointerEvent<HTMLElement>, kind: "resize" | "rotate", handle?: FrameHandle) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    press.current = { kind, handle, x: event.clientX, y: event.clientY };
    if (kind === "resize" && handle) onResizeStart(handle);
    else onRotateStart();
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (p.kind === "resize" && p.handle) {
      onResizeMove(p.handle, event.clientX - p.x, event.clientY - p.y, event.shiftKey);
      return;
    }
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    onRotateMove(rotationToward(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2), event.shiftKey));
  };
  const end = () => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    if (p.kind === "resize") onResizeEnd();
    else onRotateEnd();
  };

  const scale = 1 / zoom;
  return createPortal(
    <div
      ref={frameRef}
      className={cx(styles.frame, !editable && styles.locked)}
      style={{
        left,
        top,
        width,
        height,
        transform: `rotate(${rotation}deg)`,
        ["--frame-scale" as string]: scale,
      }}
      data-testid="selection-frame"
    >
      {label ? (
        <span className={styles.label} style={{ transform: `translate(-50%, 0) rotate(${-rotation}deg) scale(${scale})` }}>
          {label}
        </span>
      ) : null}
      {editable ? (
        <>
          <span className={styles.stem} aria-hidden="true" />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={styles.knob}
            title={t("roomMap:frame.rotate")}
            data-testid="frame-rotate"
            onPointerDown={(event) => begin(event, "rotate")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 2.5 9 6.5H3Z" fill="currentColor" />
            </svg>
          </button>
          {FRAME_HANDLES.map((handle) => (
            <span
              key={handle}
              className={cx(styles.handle, styles[handle])}
              style={{ cursor: CURSOR[handle] }}
              data-testid={`frame-handle-${handle}`}
              onPointerDown={(event) => begin(event, "resize", handle)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onLostPointerCapture={end}
            />
          ))}
        </>
      ) : null}
    </div>,
    layer,
  );
}
