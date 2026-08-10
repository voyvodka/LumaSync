// ControlPopupApp — root of the `led-control-popup` webview. Reachable only by
// choosing test mode, so it auto-starts on reveal and applies every selection
// immediately; `PATTERN_PREVIEW_ONLY` is a success, not an error.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { shellStore } from "../../persistence/shellStore";
import { HsvColorPicker } from "../../../shared/ui/HsvColorPicker";
import { setLightingMode, stopLighting } from "../../mode/modeApi";
import {
  LIGHTING_MODE_KIND,
  type AmbilightPayload,
  type LightingModeConfig,
  type LightingModeKind,
} from "../../mode/model/contracts";
import type { ColorCorrectionConfig, FirmwareProfile } from "../../../shared/contracts/device";
import type { DisplayId } from "../../../shared/contracts/display";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";
import {
  LED_TEST_STATUS,
  type LedTestPattern,
  type LedTestPatternKind,
  type LedTestPatternResult,
  type TestPatternSpeed,
} from "../../../shared/contracts/preview";
import { useSolidColorDraft } from "../../settings/sections/control/useSolidColorDraft";
import { closeLedTwinOverlay, hideLedControlPopup } from "../previewApi";
import { useLightingModeSync } from "../state/useLightingModeSync";
import {
  isTestPatternErrorCode,
  useTestPatternRunner,
  type TestPatternRunRequest,
} from "../state/useTestPatternRunner";
import { PatternPicker } from "./PatternPicker";

interface ModeStamps {
  targets: HueRuntimeTarget[];
  ledCalibration?: LightingModeConfig["ledCalibration"];
  colorCorrection?: ColorCorrectionConfig;
  firmwareProfile?: FirmwareProfile;
  ambilight?: AmbilightPayload;
  displayId?: DisplayId;
}

const DEFAULT_SOLID = { r: 255, g: 255, b: 255, brightness: 1 };

/** Patterns whose payload carries an RGB triple, so they track the colour editor. */
const COLOR_PATTERNS: ReadonlySet<LedTestPatternKind> = new Set(["solid", "chase"]);

/** Trailing window for `lastLedTestPattern` writes so a colour drag hits disk once. */
const PERSIST_PATTERN_DEBOUNCE_MS = 600;

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

function buildRunRequest(
  kind: LedTestPatternKind,
  color: SolidDraft,
  speed: TestPatternSpeed,
  targets: HueRuntimeTarget[],
): TestPatternRunRequest {
  const pattern: LedTestPattern = COLOR_PATTERNS.has(kind)
    ? ({ kind, r: color.r, g: color.g, b: color.b } as LedTestPattern)
    : ({ kind } as LedTestPattern);
  return { pattern, brightness: color.brightness, speed, targets };
}

function toHexPair(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, "0");
}
function toHex(rgb: { r: number; g: number; b: number }): string {
  return `#${toHexPair(rgb.r)}${toHexPair(rgb.g)}${toHexPair(rgb.b)}`;
}
function fromHex(hex: string): { r: number; g: number; b: number } {
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 255, g: 255, b: 255 };
  return {
    r: Number.parseInt(s.slice(0, 2), 16),
    g: Number.parseInt(s.slice(2, 4), 16),
    b: Number.parseInt(s.slice(4, 6), 16),
  };
}

export function ControlPopupApp() {
  const { t } = useTranslation("common");
  const { mode, preview } = useLightingModeSync();

  const stampsRef = useRef<ModeStamps>({ targets: ["usb"] });
  const [patternKind, setPatternKind] = useState<LedTestPatternKind>("gamut");
  const [speed, setSpeed] = useState<TestPatternSpeed>("med");
  const [runError, setRunError] = useState<string | null>(null);
  // FE-3: PREVIEW_ONLY is a success, not an error — surfaced as a distinct
  // non-error info note rather than via `runError`.
  const [previewOnly, setPreviewOnly] = useState(false);
  // User intent that the synthetic test — not the mode strip — owns the light.
  // Set by auto-start and by picking a pattern; cleared by Stop / a mode click.
  const [testDesired, setTestDesired] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // ── Load persisted stamps + last test pattern once on mount ──────────────
  useEffect(() => {
    let alive = true;
    void shellStore
      .load()
      .then((state) => {
        if (!alive) return;
        stampsRef.current = {
          targets:
            state.lastOutputTargets && state.lastOutputTargets.length > 0
              ? state.lastOutputTargets
              : ["usb"],
          ledCalibration: state.ledCalibration,
          colorCorrection: state.colorCorrection,
          firmwareProfile: state.firmwareProfile,
          ambilight: state.lightingMode?.ambilight,
          displayId: state.selectedDisplayId,
        };
        if (state.lastLedTestPattern) {
          setPatternKind(state.lastLedTestPattern.kind);
        }
      })
      .catch((error) => {
        console.error("[LumaSync] ControlPopupApp stamp load failed:", error);
      })
      .finally(() => {
        // Auto-start waits on this either way — a failed load still has a
        // usable default pattern, and a popup that lights nothing is the exact
        // dead end this window is meant to avoid.
        if (alive) setHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const kind = mode?.kind ?? LIGHTING_MODE_KIND.OFF;
  const isSolid = kind === LIGHTING_MODE_KIND.SOLID;
  const testActive = preview?.testActive ?? false;
  const popupVisible = preview?.popupVisible ?? false;
  const testEngaged = testDesired || testActive;
  const showColorPicker = testEngaged ? COLOR_PATTERNS.has(patternKind) : isSolid;
  const showBrightness = testEngaged || isSolid;

  // ── Solid color draft (shared HSV picker + throttled brightness) ─────────
  const incomingSolid = useMemo(
    () => ({
      r: mode?.solid?.r ?? DEFAULT_SOLID.r,
      g: mode?.solid?.g ?? DEFAULT_SOLID.g,
      b: mode?.solid?.b ?? DEFAULT_SOLID.b,
      brightness: mode?.solid?.brightness ?? DEFAULT_SOLID.brightness,
    }),
    [mode?.solid?.r, mode?.solid?.g, mode?.solid?.b, mode?.solid?.brightness],
  );

  const withStamps = useCallback((base: LightingModeConfig): LightingModeConfig => {
    const s = stampsRef.current;
    return {
      ...base,
      targets: base.targets ?? s.targets,
      displayId: base.displayId ?? s.displayId,
      colorCorrection: base.colorCorrection ?? s.colorCorrection,
      firmwareProfile: base.firmwareProfile ?? s.firmwareProfile,
      ledCalibration: base.ledCalibration ?? s.ledCalibration,
      ambilight: base.ambilight ?? s.ambilight,
    };
  }, []);

  // ── Test pattern runner ──────────────────────────────────────────────────
  const persistTimerRef = useRef<number | null>(null);
  const persistPatternRef = useRef<LedTestPattern | null>(null);

  const queuePersistPattern = useCallback((pattern: LedTestPattern) => {
    persistPatternRef.current = pattern;
    if (persistTimerRef.current !== null) return;
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      const latest = persistPatternRef.current;
      if (!latest) return;
      void shellStore.save({ lastLedTestPattern: latest }).catch((error) => {
        console.error("[LumaSync] ControlPopupApp persist lastLedTestPattern failed:", error);
      });
    }, PERSIST_PATTERN_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    },
    [],
  );

  const handleRunResult = useCallback(
    (result: LedTestPatternResult, request: TestPatternRunRequest) => {
      const code = result.status.code;
      if (isTestPatternErrorCode(code)) {
        setRunError(t(`ledPreview.status.${code}`));
        setPreviewOnly(false);
        return;
      }
      setRunError(null);
      setPreviewOnly(code === LED_TEST_STATUS.PATTERN_PREVIEW_ONLY || result.previewOnly === true);
      queuePersistPattern(request.pattern);
    },
    [queuePersistPattern, t],
  );

  const runner = useTestPatternRunner({ onResult: handleRunResult });

  const handleSolidCommit = useCallback(
    (next: SolidDraft) => {
      // While the test owns the light, a colour/brightness move must refresh
      // the pattern — routing it to `setLightingMode` would kill the test.
      if (testEngaged) {
        runner.refresh(buildRunRequest(patternKind, next, speed, stampsRef.current.targets));
        return;
      }
      if (!isSolid) return;
      void (async () => {
        try {
          await setLightingMode(withStamps({ kind: LIGHTING_MODE_KIND.SOLID, solid: next }));
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp solid commit failed:", error);
        }
      })();
    },
    [isSolid, patternKind, runner, speed, testEngaged, withStamps],
  );

  const { draft, setColor, setBrightness } = useSolidColorDraft({
    incoming: incomingSolid,
    onCommit: handleSolidCommit,
  });

  // ── Test pattern selection — every change applies immediately ────────────
  const handleSelectKind = useCallback(
    (next: LedTestPatternKind) => {
      setPatternKind(next);
      setTestDesired(true);
      runner.apply(buildRunRequest(next, draft, speed, stampsRef.current.targets));
    },
    [draft, runner, speed],
  );

  const handleSpeedChange = useCallback(
    (next: TestPatternSpeed) => {
      setSpeed(next);
      if (!testEngaged) return;
      runner.apply(buildRunRequest(patternKind, draft, next, stampsRef.current.targets));
    },
    [draft, patternKind, runner, testEngaged],
  );

  const handleStart = useCallback(() => {
    setTestDesired(true);
    runner.apply(buildRunRequest(patternKind, draft, speed, stampsRef.current.targets));
  }, [draft, patternKind, runner, speed]);

  // ── Mode strip handlers ──────────────────────────────────────────────────
  const handleModeClick = useCallback(
    (next: LightingModeKind) => {
      setTestDesired(false);
      setRunError(null);
      setPreviewOnly(false);
      void (async () => {
        try {
          // Drop queued refreshes and let any in-flight start land first, so a
          // pattern restart cannot resolve on top of the mode the user just chose.
          runner.cancel();
          await runner.settled();
          if (next === LIGHTING_MODE_KIND.OFF) {
            await stopLighting();
            return;
          }
          if (next === LIGHTING_MODE_KIND.AMBILIGHT) {
            await setLightingMode(
              withStamps({
                kind: LIGHTING_MODE_KIND.AMBILIGHT,
                ambilight: stampsRef.current.ambilight ?? { brightness: 1 },
              }),
            );
            return;
          }
          await setLightingMode(
            withStamps({
              kind: LIGHTING_MODE_KIND.SOLID,
              solid: { r: draft.r, g: draft.g, b: draft.b, brightness: draft.brightness },
            }),
          );
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp mode change failed:", error);
        }
      })();
    },
    [runner, withStamps, draft.r, draft.g, draft.b, draft.brightness],
  );

  const handleStop = useCallback(() => {
    setTestDesired(false);
    void (async () => {
      await runner.stop();
      setRunError(null);
      setPreviewOnly(false);
    })();
  }, [runner]);

  // ── Auto-start ───────────────────────────────────────────────────────────
  // Keep the latest selection reachable from the reveal effect without making
  // that effect depend on (and therefore re-fire on) every draft keystroke.
  const startSelectedRef = useRef<() => void>(() => {});
  useEffect(() => {
    startSelectedRef.current = handleStart;
  });

  const autoStartRef = useRef({ armed: true, wasVisible: false });
  useEffect(() => {
    if (!hydrated) return;
    const gate = autoStartRef.current;
    const revealed = popupVisible && !gate.wasVisible;
    gate.wasVisible = popupVisible;
    // Not suppressed when the mode strip reads Off: testing a strip with the
    // room lighting off is the normal case, and Stop restores the prior mode.
    if (!gate.armed && !revealed) return;
    gate.armed = false;
    startSelectedRef.current();
  }, [hydrated, popupVisible]);

  // ── Close + first-close reopen hint ──────────────────────────────────────
  // `hide_led_control_popup` keeps the webview alive only for a cheap re-show;
  // every user-visible effect here is a real close.
  const handleClose = useCallback(() => {
    setTestDesired(false);
    void (async () => {
      // Capture the hint flag BEFORE we flip popup visibility.
      let hintAlreadyShown = true;
      try {
        const state = await shellStore.load();
        hintAlreadyShown = state.ledPreviewHintShown === true;
      } catch (error) {
        console.error("[LumaSync] ControlPopupApp hint flag read failed:", error);
      }

      await runner.stop();
      setRunError(null);
      setPreviewOnly(false);

      // The twin is click-through with no decorations, taskbar entry or tray
      // item, so dropping the popup without it would strand an undismissable
      // layer over the whole display.
      await closeLedTwinOverlay();
      await hideLedControlPopup();

      try {
        await shellStore.save({ ledPreviewPopupVisible: false, ledTwinEnabledTest: false });
      } catch (error) {
        console.error("[LumaSync] ControlPopupApp persist popup-closed failed:", error);
      }

      if (!hintAlreadyShown) {
        try {
          await invoke("show_notification", {
            payload: {
              title: t("ledPreview.title"),
              body: t("ledPreview.control.reopenHint"),
              kind: "info",
            },
          });
        } catch (error) {
          console.warn("[LumaSync] ControlPopupApp reopen-hint notification failed:", error);
        }
        try {
          await shellStore.save({ ledPreviewHintShown: true });
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp persist hint-shown failed:", error);
        }
      }
    })();
  }, [runner, t]);

  // ── Status chip ──────────────────────────────────────────────────────────
  const chip = testActive
    ? { cls: "is-test", label: t("ledPreview.status.test") }
    : preview?.source === "live"
      ? { cls: "is-live", label: t("ledPreview.status.live") }
      : null;

  const hexColor = toHex(draft);
  const brightnessPct = Math.round(draft.brightness * 100);

  return (
    <div className="lm-control-root">
      {/* Header — draggable region */}
      <header className="lm-control-header" data-tauri-drag-region>
        <span className="lm-control-title" data-tauri-drag-region>
          {t("ledPreview.title")}
        </span>
        {chip && (
          <span className={`lm-control-chip ${chip.cls}`} role="status">
            <span className="dot" aria-hidden="true" />
            {chip.label}
          </span>
        )}
        <button
          type="button"
          className="lm-control-close"
          onClick={handleClose}
          aria-label={t("ledPreview.control.close")}
          title={t("ledPreview.control.closeHint")}
        >
          {t("ledPreview.control.close")}
        </button>
      </header>

      <div className="lm-control-body">
        {/* Mode strip */}
        <div>
          <div className="lm-control-section-title">{t("general.mode.title")}</div>
          <div className="lm-control-mode-strip" role="radiogroup" aria-label={t("general.mode.title")}>
            <ModeButton
              kind={LIGHTING_MODE_KIND.OFF}
              active={!testActive && kind === LIGHTING_MODE_KIND.OFF}
              label={t("general.mode.options.off")}
              icon={<IconOff />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.AMBILIGHT}
              active={!testActive && kind === LIGHTING_MODE_KIND.AMBILIGHT}
              label={t("general.mode.options.ambilight")}
              icon={<IconAmbilight />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.SOLID}
              active={!testActive && isSolid}
              label={t("general.mode.options.solid")}
              icon={<IconSolid />}
              onClick={handleModeClick}
            />
          </div>
        </div>

        {/* Colour editor — drives Solid mode, or the running solid/chase test */}
        {showBrightness && (
          <div>
            <div className="lm-control-section-title flex items-center justify-between">
              <span>{showColorPicker ? t("general.mode.solidColor") : t("general.mode.brightness")}</span>
              <span className="[font-family:var(--lm-mono)] text-[10px] text-[var(--lm-ink-dim)]">
                {showColorPicker ? `${hexColor.toUpperCase()} · ` : ""}
                <span className="lm-control-readout-num">{brightnessPct}%</span>
              </span>
            </div>
            <div className="flex flex-col items-center gap-3">
              {showColorPicker && (
                <HsvColorPicker
                  value={hexColor}
                  onChange={(hex) => setColor(fromHex(hex))}
                  ariaLabel={t("general.mode.solidColor")}
                  compact
                />
              )}
              <label className="w-full">
                <span className="sr-only">{t("general.mode.brightness")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={brightnessPct}
                  aria-label={t("general.mode.brightness")}
                  className="h-2 w-full cursor-pointer appearance-none rounded-full"
                  style={{
                    accentColor: "var(--lm-amber)",
                    background: `linear-gradient(to right, var(--lm-amber) 0%, var(--lm-amber) ${brightnessPct}%, var(--lm-line-2) ${brightnessPct}%, var(--lm-line-2) 100%)`,
                  }}
                  onChange={(e) => setBrightness(Number.parseInt(e.currentTarget.value, 10) / 100)}
                />
              </label>
            </div>
          </div>
        )}

        {/* Pattern picker — selecting applies immediately, no confirmation step */}
        <div>
          <PatternPicker
            selectedKind={patternKind}
            speed={speed}
            running={testActive}
            onSelectKind={handleSelectKind}
            onSpeedChange={handleSpeedChange}
          />
          {runError && (
            <p className="mt-2 [font-family:var(--lm-mono)] text-[10px] leading-snug text-[var(--lm-red)]" role="alert">
              {runError}
            </p>
          )}
          {!runError && previewOnly && (
            <p className="lm-control-info" role="status">
              <span className="lm-control-info-dot" aria-hidden="true" />
              {t("ledPreview.status.LED_TEST_PATTERN_PREVIEW_ONLY")}
            </p>
          )}
        </div>

        <p className="lm-control-drag-hint">{t("ledPreview.control.dragHint")}</p>
      </div>

      {/* Test footer — the only run control; Stop while live, Start once idle */}
      <footer className={`lm-test-footer ${testActive ? "" : "is-idle"}`}>
        {testActive ? (
          <span className="lm-test-pulse" aria-hidden="true" />
        ) : (
          <span className="lm-test-dot" aria-hidden="true" />
        )}
        <span className="lm-test-footer-text">
          {!testActive
            ? t("ledPreview.test.idle")
            : preview?.activePattern
              ? `${t("ledPreview.test.running")} · ${t(`ledPreview.pattern.${preview.activePattern.kind}`)}`
              : t("ledPreview.test.running")}
        </span>
        {testActive ? (
          <button type="button" className="lm-control-stop" onClick={handleStop}>
            {t("ledPreview.test.stop")}
          </button>
        ) : (
          <button type="button" className="lm-control-start" onClick={handleStart}>
            {t("ledPreview.test.run")}
          </button>
        )}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode button + icons
// ---------------------------------------------------------------------------

interface ModeButtonProps {
  kind: LightingModeKind;
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: (kind: LightingModeKind) => void;
}

function ModeButton({ kind, active, label, icon, onClick }: ModeButtonProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`lm-control-mbtn ${active ? "is-on" : ""}`}
      onClick={() => onClick(kind)}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function IconOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
  );
}
function IconAmbilight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5.5" width="18" height="12" rx="1.5" />
      <path d="M2 9l2-2M22 9l-2-2M2 14l2 2M22 14l-2 2" />
    </svg>
  );
}
function IconSolid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
