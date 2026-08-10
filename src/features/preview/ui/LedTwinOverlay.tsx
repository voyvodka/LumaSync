/**
 * LedTwinOverlay — the click-through "digital twin" of the physical strip.
 *
 * Rendered in its own borderless, transparent, click-through webview window
 * that covers exactly one display. `main.tsx` routes to this component when the
 * window label starts with `led-twin-overlay-` and threads the display id
 * (injected by Rust as `window.__LUMASYNC_TWIN_DISPLAY_ID__`).
 *
 * Correctness contract: `twin LED #N === physical strip LED #N`. We achieve
 * that by loading the persisted `ledCalibration` and computing perimeter
 * positions through `computeTwinLedPositions`, which REUSES the canonical
 * `buildLedSequence` ordering. The enriched `EdgeSignalPayload.leds` buffer is
 * emitted in that same order, so `leds[N]` is the colour of the dot at
 * `positions[N]`.
 *
 * Phase 1 is TEST MODE with screen capture OFF — frames are synthetic. The
 * overlay never reads the screen; it only mirrors whatever the worker streams.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "../../persistence/shellStore";
import { normalizeLedCalibrationConfig } from "../../calibration/model/contracts";
import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import type { LedSegmentKey } from "../../../shared/contracts/calibration";
import type { TwinScope } from "../../../shared/contracts/preview";
import { computeTwinLedPositions, type TwinLedPosition } from "../geometry";
import { useLedPreviewFrame } from "../state/useLedPreviewFrame";
import { LedGlowDot } from "./LedGlowDot";

export interface LedTwinOverlayProps {
  /** Display this overlay mirrors. Threaded from the Rust-injected global. */
  displayId?: string;
  /** Which signal the overlay reflects (synthetic test vs live capture). */
  scope?: TwinScope;
}

/** Dim "off" colour shown for an LED when no frame has streamed yet. */
const OFF_COLOR: [number, number, number] = [16, 18, 24];
const DOT_SIZE_PX = 18;

function edgeOf(positions: TwinLedPosition[], edge: LedSegmentKey): TwinLedPosition[] {
  return positions.filter((p) => p.edge === edge);
}

/**
 * Build a `linear-gradient` for one edge ribbon from the live LED colours,
 * sorted along the edge. Returns `null` when the edge has no LEDs.
 */
function edgeGradient(
  positions: TwinLedPosition[],
  edge: LedSegmentKey,
  colorAt: (index: number) => [number, number, number],
): string | null {
  const onEdge = edgeOf(positions, edge);
  if (onEdge.length === 0) return null;
  const horizontal = edge === "top" || edge === "bottom";
  const sorted = [...onEdge].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const stops = sorted.map((p) => {
    const c = colorAt(p.index);
    const pct = (horizontal ? p.x : p.y) * 100;
    return `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${pct.toFixed(1)}%`;
  });
  const dir = horizontal ? "to right" : "to bottom";
  return `linear-gradient(${dir}, ${stops.join(", ")})`;
}

export function LedTwinOverlay({ displayId, scope = "test" }: LedTwinOverlayProps) {
  const { t } = useTranslation("common");
  const [calibration, setCalibration] = useState<LedCalibrationConfig | null>(null);
  const frame = useLedPreviewFrame(displayId);

  // Load persisted calibration so we can size + place the strip. Re-loading is
  // cheap (plugin-store is in-memory after first open) and the overlay is a
  // short-lived window, so a one-shot mount read is sufficient for Phase 1.
  useEffect(() => {
    let alive = true;
    void shellStore
      .load()
      .then((state) => {
        if (!alive) return;
        if (state.ledCalibration) {
          setCalibration(normalizeLedCalibrationConfig(state.ledCalibration) ?? null);
        }
      })
      .catch((error) => {
        console.error("[LumaSync] LedTwinOverlay calibration load failed:", error);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Set the window title from the localized aria label so the overlay is
  // identifiable to AT / window managers even though the visual layer is
  // aria-hidden (it is a decorative ambient mirror).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = t("ledPreview.twin.ariaLabel");
    // The twin lives in a transparent OS window, but index.html's global
    // styles paint an opaque app background on <body>. Neutralize it on this
    // window only so the desktop / app behind stays fully visible — the twin
    // is just edge dots + ribbons, never a backdrop.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, [t]);

  const positions = useMemo(
    () => (calibration ? computeTwinLedPositions(calibration) : []),
    [calibration],
  );

  const colorAt = (index: number): [number, number, number] => {
    return frame?.leds[index] ?? OFF_COLOR;
  };

  const ribbons: Array<{ edge: LedSegmentKey; gradient: string }> = useMemo(() => {
    if (positions.length === 0) return [];
    const edges: LedSegmentKey[] = ["top", "right", "bottom", "left"];
    return edges
      .map((edge) => ({ edge, gradient: edgeGradient(positions, edge, colorAt) }))
      .filter((r): r is { edge: LedSegmentKey; gradient: string } => r.gradient !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, frame?.seq, frame?.leds]);

  const ribbonStyle = (edge: LedSegmentKey, gradient: string): CSSProperties => {
    const thickness = "5%";
    // Corner ownership: the vertical (left/right) ribbons run the full height
    // and OWN the four corners; the horizontal (top/bottom) ribbons inset by
    // `thickness` on each side so the two never cross — that crossing was what
    // produced the doubled-brightness corner blobs.
    switch (edge) {
      case "top":
        return { top: 0, left: thickness, right: thickness, height: thickness, background: gradient };
      case "bottom":
        return { bottom: 0, left: thickness, right: thickness, height: thickness, background: gradient };
      case "left":
        return { top: 0, bottom: 0, left: 0, width: thickness, background: gradient };
      case "right":
      default:
        return { top: 0, bottom: 0, right: 0, width: thickness, background: gradient };
    }
  };

  return (
    <div className="lm-twin-root" aria-hidden="true">
      <div className="lm-twin-scope">
        {scope === "live" ? t("ledPreview.twin.scopeLive") : t("ledPreview.twin.scopeTest")}
      </div>

      {/* Edge ribbons (under the dots) */}
      {ribbons.map(({ edge, gradient }) => (
        <div key={`ribbon-${edge}`} className="lm-twin-ribbon" style={ribbonStyle(edge, gradient)} />
      ))}

      {/* Per-LED glow dots */}
      {positions.map((p) => (
        <LedGlowDot key={p.index} x={p.x} y={p.y} color={colorAt(p.index)} size={DOT_SIZE_PX} />
      ))}

      {/* Hue zone markers — sparse, centred along the bottom. */}
      {frame && frame.hueChannels.length > 0 && (
        <div className="lm-twin-hue-row">
          {frame.hueChannels.map((c, i) => (
            <span
              key={`hue-${i}`}
              className="lm-twin-hue-chip"
              style={{
                background: `radial-gradient(circle, rgb(${c[0]}, ${c[1]}, ${c[2]}) 0%, rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5) 55%, transparent 80%)`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
