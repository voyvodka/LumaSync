// ControlPopupApp — root of the `led-control-popup` webview. Reachable only by
// choosing test mode, so it auto-starts on reveal and applies every selection
// immediately; `PATTERN_PREVIEW_ONLY` is a success, not an error. The
// auto-start drives the strip only — see `docs/architecture/hue.md`. Its mode
// strip is a lighting choice like the main window's: the Rust transaction
// runs it, on the saved outputs, and saves it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { showNotification } from "@/features/platform/platformApi";
import {
  onCurrentWindowMoved,
  readCurrentWindowLogicalCenter,
  type UnlistenFn,
} from "@/features/shell/windowApi";
import { parseHex, rgbToHex } from "@/shared/lib/color";
import { Callout } from "@/shared/ui/Callout";
import { HsvColorPicker } from "@/shared/ui/HsvColorPicker";
import { modeKind } from "@/features/mode/model/modeKinds";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { applyOutputs, retuneLighting } from "@/features/mode/modeApi";
import { needsCalibration } from "@/features/mode/state/modeApplyOutcome";
import { createRetuneCoalescer } from "@/features/mode/state/retuneCoalescer";
import { useLightingRuntime } from "@/features/mode/state/useLightingRuntime";
import {
  LIGHTING_MODE_KIND,
  normalizeSolidColorPayload,
  type LightingModeKind,
} from "@/shared/contracts/mode";
import { LIGHTING_ORIGIN, LIGHTING_OUTPUTS_STATUS } from "@/shared/contracts/lightingRuntime";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import {
  LED_TEST_STATUS,
  type LedTestPattern,
  type LedTestPatternKind,
  type LedTestPatternResult,
  type TestPatternSpeed,
} from "@/shared/contracts/preview";
import { useSolidColorDraft } from "@/features/settings/sections/control/useSolidColorDraft";
import { closeLedTwinOverlay, hideLedControlPopup } from "../previewApi";
import { usePreviewStatusSync } from "../state/usePreviewStatusSync";
import {
  isTestPatternErrorCode,
  useTestPatternRunner,
  type TestPatternRunRequest,
} from "../state/useTestPatternRunner";
import { isPickerPatternKind, PatternPicker, type PickerPatternKind } from "./PatternPicker";

/** The outputs a pattern-tile test lights: the ones the user last saved. A copy
 * held here goes stale because the webview outlives every hide, so it is
 * re-read before each use. Mode choices need none of it — Rust stamps them. */
function savedTargetsFrom(targets: HueRuntimeTarget[] | undefined): HueRuntimeTarget[] {
  return targets && targets.length > 0 ? targets : ["usb"];
}

const DEFAULT_SOLID = { r: 255, g: 255, b: 255, brightness: 1 };

/** Nobody asked for the reveal, so it never lights Hue: with no strip it runs
 * preview-only. A pattern-tile click is the gesture that reaches saved Hue. */
const AUTO_START_TARGETS: readonly HueRuntimeTarget[] = ["usb"];

/** Patterns whose payload carries an RGB triple, so they track the colour editor. */
const COLOR_PATTERNS: ReadonlySet<LedTestPatternKind> = new Set(["solid", "chase"]);

/** Trailing window for `lastLedTestPattern` writes so a colour drag hits disk once. */
const PERSIST_PATTERN_DEBOUNCE_MS = 600;

/** Trailing window for popup-centre writes so a window drag hits disk once. */
const PERSIST_CENTER_DEBOUNCE_MS = 400;

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

function buildRunRequest(
  kind: PickerPatternKind,
  color: SolidDraft,
  speed: TestPatternSpeed,
  targets: HueRuntimeTarget[],
): TestPatternRunRequest {
  const pattern: LedTestPattern = COLOR_PATTERNS.has(kind)
    ? ({ kind, r: color.r, g: color.g, b: color.b } as LedTestPattern)
    : ({ kind } as LedTestPattern);
  return { pattern, brightness: color.brightness, speed, targets };
}

export function ControlPopupApp() {
  const { t } = useTranslation();
  const { snapshot, adopt } = useLightingRuntime();
  const mode = snapshot?.mode ?? null;
  const preview = usePreviewStatusSync();
  const retunes = useMemo(() => createRetuneCoalescer((tuning) => retuneLighting(tuning)), []);

  const savedTargetsRef = useRef<HueRuntimeTarget[]>(["usb"]);
  // Targets of the run in progress. A colour or speed change retunes that run,
  // so it must not widen an auto-started strip-only test onto Hue.
  const runTargetsRef = useRef<HueRuntimeTarget[]>([...AUTO_START_TARGETS]);
  const [patternKind, setPatternKind] = useState<PickerPatternKind>("gamut");
  const [speed, setSpeed] = useState<TestPatternSpeed>("med");
  const [runError, setRunError] = useState<string | null>(null);
  // FE-3: PREVIEW_ONLY is a success, not an error — surfaced as a distinct
  // non-error info note rather than via `runError`.
  const [previewOnly, setPreviewOnly] = useState(false);
  // The running test left out a Hue target the user has saved (auto-start only).
  const [hueLeftOut, setHueLeftOut] = useState(false);
  // User intent that the synthetic test — not the mode strip — owns the light.
  // Set by auto-start and by picking a pattern; cleared by Stop / a mode click.
  const [testDesired, setTestDesired] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Re-read before each use, not once: the webview is kept alive across hides,
  // so a mount-time snapshot misses every settings change made since.
  const refreshStamps = useCallback(async () => {
    try {
      savedTargetsRef.current = savedTargetsFrom((await shellStore.load()).lastOutputTargets);
    } catch (error) {
      console.error("[LumaSync] ControlPopupApp stamp refresh failed:", error);
    }
  }, []);

  // ── Load persisted stamps + last test pattern once on mount ──────────────
  useEffect(() => {
    let alive = true;
    void shellStore
      .load()
      .then((state) => {
        if (!alive) return;
        savedTargetsRef.current = savedTargetsFrom(state.lastOutputTargets);
        const lastKind = state.lastLedTestPattern?.kind;
        if (lastKind && isPickerPatternKind(lastKind)) {
          setPatternKind(lastKind);
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

  // ── Persist the popup centre so it reopens where the user left it ────────
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let unlisten: UnlistenFn | null = null;

    const persist = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void (async () => {
          try {
            // Rust restores through LogicalPosition, so store logical px —
            // unlike the main window, whose centre is persisted in physical px.
            const center = await readCurrentWindowLogicalCenter();
            if (!alive) return;
            await shellStore.save({
              ledPreviewPopupCenterX: Math.round(center.x),
              ledPreviewPopupCenterY: Math.round(center.y),
            });
          } catch (error) {
            console.error("[LumaSync] ControlPopupApp persist popup centre failed:", error);
          }
        })();
      }, PERSIST_CENTER_DEBOUNCE_MS);
    };

    void onCurrentWindowMoved(persist)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] ControlPopupApp move listener failed:", error);
      });

    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
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
        setRunError(t(`preview:status.${code}`));
        setPreviewOnly(false);
        setHueLeftOut(false);
        return;
      }
      setRunError(null);
      setPreviewOnly(code === LED_TEST_STATUS.PATTERN_PREVIEW_ONLY || result.previewOnly === true);
      setHueLeftOut(
        !request.targets?.includes("hue") && savedTargetsRef.current.includes("hue"),
      );
      queuePersistPattern(request.pattern);
    },
    [queuePersistPattern, t],
  );

  const runner = useTestPatternRunner({ onResult: handleRunResult });

  const handleSolidCommit = useCallback(
    (next: SolidDraft) => {
      // While the test owns the light, a colour/brightness move must refresh
      // the pattern — a lighting retune would not reach it.
      if (testEngaged) {
        runner.refresh(buildRunRequest(patternKind, next, speed, runTargetsRef.current));
        return;
      }
      if (!isSolid) return;
      retunes.push({ solid: normalizeSolidColorPayload(next) });
    },
    [isSolid, patternKind, retunes, runner, speed, testEngaged],
  );

  const { draft, setColor, setBrightness } = useSolidColorDraft({
    incoming: incomingSolid,
    onCommit: handleSolidCommit,
  });

  // ── Test pattern selection — every change applies immediately ────────────
  const handleSelectKind = useCallback(
    (next: PickerPatternKind) => {
      setPatternKind(next);
      setTestDesired(true);
      runTargetsRef.current = savedTargetsRef.current;
      runner.apply(buildRunRequest(next, draft, speed, runTargetsRef.current));
    },
    [draft, runner, speed],
  );

  const handleSpeedChange = useCallback(
    (next: TestPatternSpeed) => {
      setSpeed(next);
      if (!testEngaged) return;
      runner.apply(buildRunRequest(patternKind, draft, next, runTargetsRef.current));
    },
    [draft, patternKind, runner, testEngaged],
  );

  const handleAutoStart = useCallback(() => {
    setTestDesired(true);
    runTargetsRef.current = [...AUTO_START_TARGETS];
    runner.apply(buildRunRequest(patternKind, draft, speed, runTargetsRef.current));
  }, [draft, patternKind, runner, speed]);

  // ── Mode strip handlers ──────────────────────────────────────────────────
  const handleModeClick = useCallback(
    (next: LightingModeKind) => {
      setTestDesired(false);
      setRunError(null);
      setPreviewOnly(false);
      setHueLeftOut(false);
      void (async () => {
        try {
          // Drop queued refreshes and let any in-flight start land first, so a
          // pattern restart cannot resolve on top of the mode the user just chose.
          runner.cancel();
          await runner.settled();
          retunes.reset();
          // The kind alone for Off and Ambilight: Rust keeps the last Ambilight
          // settings. Solid carries the colour on screen.
          const result = await applyOutputs({
            mode: modeKind(next).config({
              solid: { r: draft.r, g: draft.g, b: draft.b, brightness: draft.brightness },
            }),
            origin: LIGHTING_ORIGIN.POPUP,
          });
          adopt(result.snapshot);
          if (needsCalibration(result)) {
            setRunError(t("preview:control.calibrationRequired"));
          } else if (
            result.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_REFUSED ||
            result.status.code === LIGHTING_OUTPUTS_STATUS.OUTPUTS_START_FAILED
          ) {
            console.warn(
              `[LumaSync] ControlPopupApp mode ${next}: ${result.status.code}`,
              result.status.details ?? "",
            );
          }
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp mode change failed:", error);
        }
      })();
    },
    [adopt, retunes, runner, t, draft.r, draft.g, draft.b, draft.brightness],
  );

  // ── Auto-start ───────────────────────────────────────────────────────────
  // Keep the latest selection reachable from the reveal effect without making
  // that effect depend on (and therefore re-fire on) every draft keystroke.
  const startSelectedRef = useRef<() => void>(() => {});
  useEffect(() => {
    startSelectedRef.current = handleAutoStart;
  });

  const autoStartRef = useRef({ armed: true, wasVisible: false });
  useEffect(() => {
    if (!hydrated) return;
    const gate = autoStartRef.current;
    const revealed = popupVisible && !gate.wasVisible;
    gate.wasVisible = popupVisible;
    // Not suppressed when the mode strip reads Off: testing a strip with the
    // room lighting off is the normal case, and closing restores the prior mode.
    if (!gate.armed && !revealed) return;
    if (gate.armed) {
      gate.armed = false;
      startSelectedRef.current();
      return;
    }
    // A re-reveal of the kept-alive webview: refresh before the start reads targets.
    void refreshStamps().then(() => startSelectedRef.current());
  }, [hydrated, popupVisible, refreshStamps]);

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

      if (testEngaged) {
        await runner.stop();
      } else {
        // `stop_led_test_pattern` restores the captured prior mode, and a
        // mode-strip click already consumed it — stopping a test that is not
        // running would restore `Off` and kill the user's lighting.
        runner.cancel();
        await runner.settled();
      }
      setRunError(null);
      setPreviewOnly(false);
      setHueLeftOut(false);

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
          await showNotification({
            title: t("preview:title"),
            body: t("preview:control.reopenHint"),
            kind: "info",
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
  }, [runner, t, testEngaged]);

  // ── Status chip ──────────────────────────────────────────────────────────
  const chip = testActive
    ? { cls: "is-test", label: t("preview:status.test") }
    : preview?.source === "live"
      ? { cls: "is-live", label: t("preview:status.live") }
      : null;

  const hexColor = rgbToHex(draft);
  const brightnessPct = Math.round(draft.brightness * 100);

  return (
    <div className="lm-control-root">
      {/* Header — draggable region */}
      <header className="lm-control-header" data-tauri-drag-region>
        <span className="lm-control-title" data-tauri-drag-region>
          {t("preview:title")}
        </span>
        {chip && (
          <span className={`lm-control-chip ${chip.cls}`} role="status">
            <span className="dot" aria-hidden="true" />
            {chip.label}
          </span>
        )}
      </header>

      <div className="lm-control-body">
        {/* Mode strip */}
        <div>
          <div className="lm-control-section-title">{t("common:mode.title")}</div>
          <ModeStrip
            variant="popup"
            value={testActive ? null : kind}
            onSelect={handleModeClick}
          />
        </div>

        {/* Colour editor — drives Solid mode, or the running solid/chase test */}
        {showBrightness && (
          <div>
            <div className="lm-control-section-title flex items-center justify-between">
              <span>{showColorPicker ? t("common:mode.solidColor") : t("common:mode.brightness")}</span>
              <span className="font-mono text-[10px] text-ink-dim">
                {showColorPicker ? `${hexColor.toUpperCase()} · ` : ""}
                <span className="lm-control-readout-num">{brightnessPct}%</span>
              </span>
            </div>
            <div className="flex flex-col items-center gap-3">
              {showColorPicker && (
                <HsvColorPicker
                  value={hexColor}
                  onChange={(hex) => {
                    const rgb = parseHex(hex);
                    if (rgb) setColor(rgb);
                  }}
                  ariaLabel={t("common:mode.solidColor")}
                  compact
                />
              )}
              <label className="w-full">
                <span className="sr-only">{t("common:mode.brightness")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={brightnessPct}
                  aria-label={t("common:mode.brightness")}
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
            <p className="mt-2 font-mono text-[10px] leading-snug text-red" role="alert">
              {runError}
            </p>
          )}
          {!runError && hueLeftOut && (
            <Callout tone="info" className="mt-2">
              {previewOnly
                ? t("preview:control.autoStart.noStrip")
                : t("preview:control.autoStart.stripOnly")}
            </Callout>
          )}
          {!runError && !hueLeftOut && previewOnly && (
            <Callout tone="info" className="mt-2">
              {t("preview:status.LED_TEST_PATTERN_PREVIEW_ONLY")}
            </Callout>
          )}
        </div>

        <p className="lm-control-drag-hint">{t("preview:control.dragHint")}</p>
      </div>

      {/* Test footer — status readout plus the window's only exit. Starting is
          owned by the pattern tiles, so there is no separate Run control. */}
      <footer className={`lm-test-footer ${testActive ? "" : "is-idle"}`}>
        {testActive ? (
          <span className="lm-test-pulse" aria-hidden="true" />
        ) : (
          <span className="lm-test-dot" aria-hidden="true" />
        )}
        <span className="lm-test-footer-text">
          {!testActive
            ? t("preview:test.idle")
            : preview?.activePattern
              ? `${t("preview:test.running")} · ${t(`preview:pattern.${preview.activePattern.kind}`)}`
              : t("preview:test.running")}
        </span>
        <button
          type="button"
          className="lm-control-close"
          onClick={handleClose}
          title={t("preview:control.closeHint")}
        >
          {t("preview:control.close")}
        </button>
      </footer>
    </div>
  );
}
