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

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { normalizeLedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { LedSegmentKey } from "@/shared/contracts/calibration";
import type { TwinScope } from "@/shared/contracts/preview";
import { computeTwinLedPositions, type TwinLedPosition } from "../geometry";
import {
  EMPTY_PACKED_BUFFER,
  packLedBuffer,
  packLedColor,
  packedToCss,
  type PackedLedColor,
} from "../ledColor";
import { useLedPreviewFrame } from "../state/useLedPreviewFrame";
import { LedGlowDot } from "./LedGlowDot";

export interface LedTwinOverlayProps {
  /** Display this overlay mirrors. Threaded from the Rust-injected global. */
  displayId?: string;
  /** Which signal the overlay reflects (synthetic test vs live capture). */
  scope?: TwinScope;
}

/** Dim "off" colour shown for an LED when no frame has streamed yet. */
const OFF_COLOR_PACKED = packLedColor([16, 18, 24]);
const DOT_SIZE_PX = 18;
const EDGE_ORDER: LedSegmentKey[] = ["top", "right", "bottom", "left"];
/** Ribbon depth, and the corner inset the horizontal ribbons give up. */
const RIBBON_THICKNESS = 0.05;

/**
 * Viewport X → the horizontal ribbon's own 0..1 span. Those ribbons inset by
 * `RIBBON_THICKNESS` each side, so a raw offset drifts inboard of its dot.
 */
function horizontalOffset(x: number): number {
  const span = 1 - RIBBON_THICKNESS * 2;
  return Math.min(1, Math.max(0, (x - RIBBON_THICKNESS) / span));
}

/** One edge's LEDs, pre-sorted along the edge and paired with its stop offsets. */
interface EdgeTrack {
  edge: LedSegmentKey;
  direction: "to right" | "to bottom";
  /** LED buffer index → gradient stop percentage, in along-edge order. */
  stops: Array<{ index: number; offset: string }>;
}

/**
 * Split positions into per-edge tracks ONCE per calibration — the sort used to
 * run 4× per frame purely because the colour buffer changed identity.
 */
function buildEdgeTracks(positions: TwinLedPosition[]): EdgeTrack[] {
  return EDGE_ORDER.flatMap((edge) => {
    const onEdge = positions.filter((p) => p.edge === edge);
    if (onEdge.length === 0) return [];
    const horizontal = edge === "top" || edge === "bottom";
    const sorted = [...onEdge].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    return [
      {
        edge,
        direction: horizontal ? ("to right" as const) : ("to bottom" as const),
        stops: sorted.map((p) => ({
          index: p.index,
          offset: `${((horizontal ? horizontalOffset(p.x) : p.y) * 100).toFixed(1)}%`,
        })),
      },
    ];
  });
}

function edgeGradient(track: EdgeTrack, packed: readonly PackedLedColor[]): string {
  const stops = track.stops.map(
    ({ index, offset }) => `${packedToCss(packed[index] ?? OFF_COLOR_PACKED)} ${offset}`,
  );
  return `linear-gradient(${track.direction}, ${stops.join(", ")})`;
}

export function LedTwinOverlay({ displayId, scope = "test" }: LedTwinOverlayProps) {
  const { t } = useTranslation();
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
    document.title = t("preview:twin.ariaLabel");
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

  const edgeTracks = useMemo(() => buildEdgeTracks(positions), [positions]);

  // Ref-held so an unchanged frame keeps the SAME array reference and every
  // memo below bails out. Deterministic in (source, previous), so StrictMode's
  // double render is a no-op rather than a torn value.
  const packedRef = useRef<readonly PackedLedColor[]>(EMPTY_PACKED_BUFFER);
  packedRef.current = packLedBuffer(frame?.leds, packedRef.current);
  const packedLeds = packedRef.current;

  const ribbons = useMemo(
    () =>
      edgeTracks.map((track) => ({
        edge: track.edge,
        gradient: edgeGradient(track, packedLeds),
      })),
    [edgeTracks, packedLeds],
  );

  const ribbonStyle = (edge: LedSegmentKey, gradient: string): CSSProperties => {
    const thickness = `${RIBBON_THICKNESS * 100}%`;
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
        {scope === "live" ? t("preview:twin.scopeLive") : t("preview:twin.scopeTest")}
      </div>

      {/* Edge ribbons (under the dots) */}
      {ribbons.map(({ edge, gradient }) => (
        <div key={`ribbon-${edge}`} className="lm-twin-ribbon" style={ribbonStyle(edge, gradient)} />
      ))}

      {/* Per-LED glow dots */}
      {positions.map((p) => (
        <LedGlowDot
          key={p.index}
          x={p.x}
          y={p.y}
          color={packedLeds[p.index] ?? OFF_COLOR_PACKED}
          size={DOT_SIZE_PX}
        />
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
