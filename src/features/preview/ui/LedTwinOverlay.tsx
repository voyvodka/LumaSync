/**
 * LedTwinOverlay — the click-through "digital twin" of the physical strip.
 *
 * Rendered in its own borderless, transparent, click-through webview window
 * over the display Ambilight captures. `main.tsx` routes to this component when
 * the window label starts with `led-twin-overlay-`.
 *
 * Correctness contract: `twin LED #N === physical strip LED #N`. The layout is
 * the one the running mode uses (`useTwinFeed`), placed through
 * `computeTwinLedPositions`, which REUSES the canonical `buildLedSequence`
 * ordering; the frame's `leds` buffer is in that same order, so `leds[N]` is
 * the colour of the dot at `positions[N]`.
 *
 * Drawn on two canvases: the ribbons under a blur, the dots over them sharp.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { normalizeLedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { computeTwinLedPositions } from "../geometry";
import { EMPTY_PACKED_BUFFER, packLedBuffer, type PackedLedColor } from "../ledColor";
import { useTwinFeed } from "../state/useTwinFeed";
import { buildEdgeTracks, paintDots, paintRibbons } from "./twinCanvas";
import styles from "./LedTwinOverlay.module.css";

interface Viewport {
  width: number;
  height: number;
  scale: number;
}

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1 };
}

/** Sizes the canvas's backing store to the screen's pixels, and its 2D context to CSS pixels. */
function prepare(canvas: HTMLCanvasElement | null, viewport: Viewport): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  const width = Math.round(viewport.width * viewport.scale);
  const height = Math.round(viewport.height * viewport.scale);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(viewport.scale, 0, 0, viewport.scale, 0, 0);
  return ctx;
}

export function LedTwinOverlay() {
  const { t } = useTranslation();
  const { layout, frame } = useTwinFeed();
  const calibration = useMemo<LedCalibrationConfig | null>(
    () => (layout?.leds ? (normalizeLedCalibrationConfig(layout.leds) ?? null) : null),
    [layout],
  );
  const [viewport, setViewport] = useState(readViewport);
  const ribbonsRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<HTMLCanvasElement>(null);

  // Set the window title from the localized aria label so the overlay is
  // identifiable to AT / window managers even though the visual layer is
  // aria-hidden (it is a decorative ambient mirror).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = t("preview:twin.ariaLabel");
    // The twin lives in a transparent OS window, but index.html's global
    // styles paint an opaque app background on <body>. Neutralize it on this
    // window only so the desktop / app behind stays fully visible — the twin
    // is just edge dots + ribbons, never a backdrop.
    document.documentElement.style.background = "transparent";
    document.documentElement.style.colorScheme = "normal";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, [t]);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const positions = useMemo(() => (calibration ? computeTwinLedPositions(calibration) : []), [calibration]);
  const edgeTracks = useMemo(() => buildEdgeTracks(positions), [positions]);

  // Ref-held so an unchanged frame keeps the SAME array reference and the
  // paint below does not run. Deterministic in (source, previous), so
  // StrictMode's double render is a no-op rather than a torn value.
  const packedRef = useRef<readonly PackedLedColor[]>(EMPTY_PACKED_BUFFER);
  packedRef.current = packLedBuffer(frame?.leds, packedRef.current);
  const packedLeds = packedRef.current;

  useEffect(() => {
    const ribbons = prepare(ribbonsRef.current, viewport);
    const dots = prepare(dotsRef.current, viewport);
    if (ribbons) paintRibbons(ribbons, edgeTracks, packedLeds, viewport.width, viewport.height);
    if (dots) paintDots(dots, positions, packedLeds, viewport.width, viewport.height);
  }, [viewport, edgeTracks, positions, packedLeds]);

  return (
    <div className={styles.root} aria-hidden="true">
      <canvas ref={ribbonsRef} className={`${styles.layer} ${styles.ribbons}`} data-testid="twin-ribbons" />
      <canvas ref={dotsRef} className={styles.layer} data-testid="twin-dots" />

      {/* Each Hue lamp where the layout puts it: where it samples the screen, or in a row along the
          bottom when the room map does not place it. A frame cut for another set of lamps waits. */}
      {frame &&
        layout &&
        frame.lamps.length === layout.lamps.length &&
        frame.lamps.map((c, i) => (
          <span
            key={`hue-${layout.lamps[i]!.id}`}
            className={styles.hueChip}
            data-testid="twin-lamp"
            style={{
              "--lamp-x": `${layout.lamps[i]!.x * 100}%`,
              "--lamp-y": `${layout.lamps[i]!.y * 100}%`,
              background: `radial-gradient(circle, rgb(${c[0]}, ${c[1]}, ${c[2]}) 0%, rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5) 55%, transparent 80%)`,
            } as CSSProperties}
          />
        ))}
    </div>
  );
}
