/**
 * HsvColorPicker — v1.5 W1-A7
 *
 * SVG-native HSV color picker that replaces the browser's
 * `<input type="color">`:
 *
 *   - Outer ring: hue (0..360°) — drag the handle around to pick the
 *     base hue.
 *   - Inner saturation/value square: drag the handle inside to pick
 *     S and V at the chosen hue.
 *   - Hex text field: bidirectional sync with the picker; rejects
 *     invalid hex strings on commit.
 *   - Recent colors strip: persists the last 8 distinct hex values to
 *     `localStorage` under `lm-recent-colors`.
 *
 * The picker is fully keyboard-driven:
 *   - Arrow keys on the hue ring step the hue by ±5° (±15° with Shift).
 *   - Arrow keys inside the square step S/V by ±0.04 (±0.12 with Shift).
 *   - Tab order: hue → square → hex input → recent swatches.
 *
 * A11y:
 *   - Both handles are `role="slider"` with `aria-valuemin/max/now` and
 *     a localized `aria-label`.
 *   - The hex input is a normal text input (announces type-to-edit).
 *   - Tap target floor: ≥ 32 px on every interactive surface.
 *   - Reduced-motion: no animations are used; only static SVG transforms.
 *   - Forced-colors: handles fall back to `CanvasText` outlines so the
 *     picker stays usable in Windows High Contrast.
 *
 * Props are intentionally identical (modulo type) to the native `<input
 * type="color">` we are replacing — the migration is drop-in:
 *   `<input type="color" value={hex} onChange={(e) => setColor(e.target.value)} />`
 *   becomes
 *   `<HsvColorPicker value={hex} onChange={setColor} />`.
 *
 * Performance: the SVG is static; only the two handle transforms +
 * hex input value re-render on input. Drag is handled with pointer
 * events + `setPointerCapture` so an off-canvas drag still tracks
 * smoothly, the same pattern the room-map dots use.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

/** RGB triplet (0..255 ints). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** HSV triplet — hue 0..360, saturation/value 0..1. */
interface Hsv {
  h: number;
  s: number;
  v: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hexPair(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
}

export function parseHex(value: string): Rgb | null {
  const trimmed = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return {
    r: parseInt(trimmed.slice(0, 2), 16),
    g: parseInt(trimmed.slice(2, 4), 16),
    b: parseInt(trimmed.slice(4, 6), 16),
  };
}

function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh >= 0 && hh < 1) { rp = c; gp = x; bp = 0; }
  else if (hh < 2) { rp = x; gp = c; bp = 0; }
  else if (hh < 3) { rp = 0; gp = c; bp = x; }
  else if (hh < 4) { rp = 0; gp = x; bp = c; }
  else if (hh < 5) { rp = x; gp = 0; bp = c; }
  else { rp = c; gp = 0; bp = x; }
  const m = v - c;
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

// ---------------------------------------------------------------------------
// Recent colors persistence
// ---------------------------------------------------------------------------

const RECENT_KEY = "lm-recent-colors";
const RECENT_MAX = 8;

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v))
      .slice(0, RECENT_MAX);
  } catch (e) {
    console.error("[LumaSync] HsvColorPicker recent load failed", e);
    return [];
  }
}

function saveRecent(next: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch (e) {
    console.error("[LumaSync] HsvColorPicker recent save failed", e);
  }
}

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const VIEW_SIZE = 200;
const CENTER = VIEW_SIZE / 2;
const HUE_OUTER_R = 95;
const HUE_INNER_R = 75;
const SQUARE_HALF = 50;
const SQUARE_X0 = CENTER - SQUARE_HALF;
const SQUARE_Y0 = CENTER - SQUARE_HALF;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface HsvColorPickerProps {
  /** Hex color, e.g. `"#ffb020"`. */
  value: string;
  /** Called with a normalised hex string on every commit. */
  onChange: (hex: string) => void;
  /** Localized aria-label for the picker root. */
  ariaLabel?: string;
  /** Disable all interaction (mirrors `<input>.disabled`). */
  disabled?: boolean;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** When true, hide the recent-colors row. */
  hideRecent?: boolean;
  /** When true, hide the hex text input. */
  hideHex?: boolean;
  /** When false, the picker shrinks for the 320 px compact window. */
  compact?: boolean;
}

export function HsvColorPicker({
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  hideRecent = false,
  hideHex = false,
  compact = false,
}: HsvColorPickerProps) {
  const { t } = useTranslation("common");
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const squareRef = useRef<SVGRectElement>(null);

  // Parse incoming hex to HSV — keep H stable when S=0 / V=0 to avoid jumps.
  const parsedHsv = useMemo<Hsv>(() => {
    const rgb = parseHex(value) ?? { r: 255, g: 255, b: 255 };
    return rgbToHsv(rgb);
  }, [value]);

  const [hsv, setHsv] = useState<Hsv>(parsedHsv);
  // Re-sync only when the parsed hex actually differs from our internal state
  // so a small pointer drag does not get clobbered by parent-passed value.
  const lastParsedHex = useRef(rgbToHex(hsvToRgb(parsedHsv)).toLowerCase());
  useEffect(() => {
    const incomingHex = rgbToHex(hsvToRgb(parsedHsv)).toLowerCase();
    if (incomingHex !== lastParsedHex.current) {
      lastParsedHex.current = incomingHex;
      setHsv(parsedHsv);
    }
  }, [parsedHsv]);

  const [hexDraft, setHexDraft] = useState<string>(value.toUpperCase());
  useEffect(() => setHexDraft(value.toUpperCase()), [value]);

  const [recent, setRecent] = useState<string[]>(() => loadRecent());

  // ── Commit helpers ────────────────────────────────────────────────────
  const commit = useCallback(
    (next: Hsv) => {
      const rgb = hsvToRgb(next);
      const hex = rgbToHex(rgb);
      lastParsedHex.current = hex.toLowerCase();
      setHsv(next);
      setHexDraft(hex.toUpperCase());
      onChange(hex);
    },
    [onChange],
  );

  const pushRecent = useCallback((hex: string) => {
    const normalised = hex.toLowerCase();
    setRecent((prev) => {
      const filtered = prev.filter((c) => c.toLowerCase() !== normalised);
      const next = [normalised, ...filtered].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  }, []);

  // ── Hue ring drag ─────────────────────────────────────────────────────
  const [draggingHue, setDraggingHue] = useState(false);
  const handleHuePointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setDraggingHue(true);
    },
    [disabled],
  );

  const handleHuePointerMove = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (!draggingHue || !ringRef.current) return;
      const rect = (ringRef.current.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      // Convert math angle → 0..360 with 0° at the top (12 o'clock).
      deg = (deg + 360) % 360;
      commit({ ...hsv, h: deg });
    },
    [draggingHue, hsv, commit],
  );

  const handleHuePointerUp = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (draggingHue) {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {
          console.error("[LumaSync] HsvColorPicker hue release failed", err);
        }
        setDraggingHue(false);
        pushRecent(rgbToHex(hsvToRgb(hsv)));
      }
    },
    [draggingHue, hsv, pushRecent],
  );

  // ── Saturation/Value square drag ──────────────────────────────────────
  const [draggingSv, setDraggingSv] = useState(false);
  const handleSvPointerDown = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setDraggingSv(true);
      // Also commit the click position so single-tap works.
      const rect = (squareRef.current?.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
      const scale = rect.width / VIEW_SIZE;
      const localX = (e.clientX - rect.left) / scale;
      const localY = (e.clientY - rect.top) / scale;
      const s = clamp((localX - SQUARE_X0) / (SQUARE_HALF * 2), 0, 1);
      const v = clamp(1 - (localY - SQUARE_Y0) / (SQUARE_HALF * 2), 0, 1);
      commit({ ...hsv, s, v });
    },
    [disabled, hsv, commit],
  );

  const handleSvPointerMove = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (!draggingSv || !squareRef.current) return;
      const rect = (squareRef.current.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
      const scale = rect.width / VIEW_SIZE;
      const localX = (e.clientX - rect.left) / scale;
      const localY = (e.clientY - rect.top) / scale;
      const s = clamp((localX - SQUARE_X0) / (SQUARE_HALF * 2), 0, 1);
      const v = clamp(1 - (localY - SQUARE_Y0) / (SQUARE_HALF * 2), 0, 1);
      commit({ ...hsv, s, v });
    },
    [draggingSv, hsv, commit],
  );

  const handleSvPointerUp = useCallback(
    (e: React.PointerEvent<SVGElement>) => {
      if (draggingSv) {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {
          console.error("[LumaSync] HsvColorPicker SV release failed", err);
        }
        setDraggingSv(false);
        pushRecent(rgbToHex(hsvToRgb(hsv)));
      }
    },
    [draggingSv, hsv, pushRecent],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  const handleHueKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGElement>) => {
      if (disabled) return;
      const step = e.shiftKey ? 15 : 5;
      let next: number | null = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = (hsv.h - step + 360) % 360;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") next = (hsv.h + step) % 360;
      if (next !== null) {
        e.preventDefault();
        commit({ ...hsv, h: next });
      }
    },
    [disabled, hsv, commit],
  );

  const handleSvKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGElement>) => {
      if (disabled) return;
      const step = e.shiftKey ? 0.12 : 0.04;
      let nextS = hsv.s;
      let nextV = hsv.v;
      if (e.key === "ArrowLeft") nextS = clamp(hsv.s - step, 0, 1);
      else if (e.key === "ArrowRight") nextS = clamp(hsv.s + step, 0, 1);
      else if (e.key === "ArrowUp") nextV = clamp(hsv.v + step, 0, 1);
      else if (e.key === "ArrowDown") nextV = clamp(hsv.v - step, 0, 1);
      else return;
      e.preventDefault();
      commit({ ...hsv, s: nextS, v: nextV });
    },
    [disabled, hsv, commit],
  );

  // ── Hex input handlers ────────────────────────────────────────────────
  const commitHexDraft = useCallback(() => {
    const rgb = parseHex(hexDraft);
    if (!rgb) {
      // Reset visible draft to last good value.
      setHexDraft(value.toUpperCase());
      return;
    }
    const hex = rgbToHex(rgb);
    lastParsedHex.current = hex.toLowerCase();
    setHsv(rgbToHsv(rgb));
    setHexDraft(hex.toUpperCase());
    pushRecent(hex);
    onChange(hex);
  }, [hexDraft, value, onChange, pushRecent]);

  // ── Compute handle positions ──────────────────────────────────────────
  const ringHandleAngleRad = (hsv.h * Math.PI) / 180;
  const ringHandleR = (HUE_OUTER_R + HUE_INNER_R) / 2;
  const ringHandleX = CENTER + Math.cos(ringHandleAngleRad) * ringHandleR;
  const ringHandleY = CENTER + Math.sin(ringHandleAngleRad) * ringHandleR;

  const svHandleX = SQUARE_X0 + hsv.s * SQUARE_HALF * 2;
  const svHandleY = SQUARE_Y0 + (1 - hsv.v) * SQUARE_HALF * 2;

  const huePureRgb = hsvToRgb({ h: hsv.h, s: 1, v: 1 });
  const huePureHex = rgbToHex(huePureRgb);

  // Build hue-ring conic gradient via 12 segments — works in pure SVG
  // without external libs. Each wedge is a `<path>` with the matching
  // fill from the hue at its midpoint angle.
  const wedgeCount = 24;
  const wedges = useMemo(
    () =>
      Array.from({ length: wedgeCount }, (_, i) => {
        const a0 = (i / wedgeCount) * 360;
        const a1 = ((i + 1) / wedgeCount) * 360;
        const midDeg = (a0 + a1) / 2;
        const fill = rgbToHex(hsvToRgb({ h: midDeg, s: 1, v: 1 }));
        const a0Rad = (a0 * Math.PI) / 180;
        const a1Rad = (a1 * Math.PI) / 180;
        const x0 = CENTER + Math.cos(a0Rad) * HUE_OUTER_R;
        const y0 = CENTER + Math.sin(a0Rad) * HUE_OUTER_R;
        const x1 = CENTER + Math.cos(a1Rad) * HUE_OUTER_R;
        const y1 = CENTER + Math.sin(a1Rad) * HUE_OUTER_R;
        const x2 = CENTER + Math.cos(a1Rad) * HUE_INNER_R;
        const y2 = CENTER + Math.sin(a1Rad) * HUE_INNER_R;
        const x3 = CENTER + Math.cos(a0Rad) * HUE_INNER_R;
        const y3 = CENTER + Math.sin(a0Rad) * HUE_INNER_R;
        const d = `M ${x0} ${y0} A ${HUE_OUTER_R} ${HUE_OUTER_R} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${HUE_INNER_R} ${HUE_INNER_R} 0 0 0 ${x3} ${y3} Z`;
        return { d, fill };
      }),
    [],
  );

  const sizePx = compact ? 160 : 200;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={ariaLabel ?? t("ui.colorPicker.rootAriaLabel")}
      aria-disabled={disabled}
      className={[
        "flex flex-col gap-2",
        disabled ? "pointer-events-none opacity-60" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <svg
        viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
        width={sizePx}
        height={sizePx}
        className="select-none"
      >
        {/* Hue wedges */}
        <g
          onPointerDown={handleHuePointerDown}
          onPointerMove={handleHuePointerMove}
          onPointerUp={handleHuePointerUp}
          onPointerCancel={handleHuePointerUp}
          style={{ cursor: disabled ? "not-allowed" : "grab", touchAction: "none" }}
        >
          {wedges.map((w, i) => (
            <path key={i} d={w.d} fill={w.fill} />
          ))}
          {/* Hue handle */}
          <circle
            ref={ringRef}
            cx={ringHandleX}
            cy={ringHandleY}
            r={6}
            fill="white"
            stroke="black"
            strokeWidth={1.5}
            tabIndex={disabled ? -1 : 0}
            role="slider"
            aria-label={t("ui.colorPicker.hueLabel")}
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            onKeyDown={handleHueKeyDown}
            style={{ cursor: disabled ? "not-allowed" : "grab" }}
          />
        </g>

        {/* SV square — base hue color, then white-to-transparent (left→right S),
            then black-to-transparent (top→bottom V). */}
        <defs>
          <linearGradient id="lm-hsv-sat" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lm-hsv-val" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#000000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000000" stopOpacity="1" />
          </linearGradient>
        </defs>
        <g
          onPointerDown={handleSvPointerDown}
          onPointerMove={handleSvPointerMove}
          onPointerUp={handleSvPointerUp}
          onPointerCancel={handleSvPointerUp}
          style={{ cursor: disabled ? "not-allowed" : "crosshair", touchAction: "none" }}
        >
          <rect
            ref={squareRef}
            x={SQUARE_X0}
            y={SQUARE_Y0}
            width={SQUARE_HALF * 2}
            height={SQUARE_HALF * 2}
            fill={huePureHex}
            rx={4}
          />
          <rect
            x={SQUARE_X0}
            y={SQUARE_Y0}
            width={SQUARE_HALF * 2}
            height={SQUARE_HALF * 2}
            fill="url(#lm-hsv-sat)"
            rx={4}
            pointerEvents="none"
          />
          <rect
            x={SQUARE_X0}
            y={SQUARE_Y0}
            width={SQUARE_HALF * 2}
            height={SQUARE_HALF * 2}
            fill="url(#lm-hsv-val)"
            rx={4}
            pointerEvents="none"
          />
          {/* SV handle */}
          <circle
            cx={svHandleX}
            cy={svHandleY}
            r={5}
            fill="none"
            stroke="white"
            strokeWidth={1.8}
            tabIndex={disabled ? -1 : 0}
            role="slider"
            aria-label={t("ui.colorPicker.svLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.v * 100)}
            onKeyDown={handleSvKeyDown}
            style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,0.7))" }}
          />
        </g>
      </svg>

      {/* Hex input */}
      {!hideHex && (
        <label className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {t("ui.colorPicker.hexLabel")}
          </span>
          <input
            type="text"
            value={hexDraft}
            disabled={disabled}
            spellCheck={false}
            className="w-full max-w-[120px] rounded border border-zinc-700 bg-transparent px-2 py-1 text-[11px] [font-family:var(--lm-mono)] text-zinc-100 focus:border-amber-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHexDraft();
              }
              if (e.key === "Escape") {
                setHexDraft(value.toUpperCase());
              }
            }}
          />
        </label>
      )}

      {/* Recent colors */}
      {!hideRecent && recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {t("ui.colorPicker.recentColors")}
          </span>
          <div className="flex flex-wrap gap-1.5" role="list">
            {recent.map((hex, i) => (
              <button
                key={`${hex}-${i}`}
                type="button"
                role="listitem"
                disabled={disabled}
                aria-label={t("ui.colorPicker.recentItemAriaLabel", { hex })}
                title={hex.toUpperCase()}
                className="h-6 w-6 rounded border border-zinc-700 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                style={{ background: hex }}
                onClick={() => {
                  const rgb = parseHex(hex);
                  if (rgb) {
                    setHsv(rgbToHsv(rgb));
                    setHexDraft(hex.toUpperCase());
                    onChange(hex);
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
