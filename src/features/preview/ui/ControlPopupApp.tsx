// ControlPopupApp — root of the `led-control-popup` webview, the preview
// session's remote. Opening it changes no light. Its mode strip is a lighting
// choice like the main window's: the Rust transaction runs it, on the saved
// outputs, and saves it. Close ends the session; Hide keeps it open.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import {
  onCurrentWindowMoved,
  readCurrentWindowLogicalCenter,
  type UnlistenFn,
} from "@/features/shell/windowApi";
import { parseHex, rgbToHex } from "@/shared/lib/color";
import { HsvColorPicker } from "@/shared/ui/HsvColorPicker/HsvColorPicker";
import { modeKind } from "@/features/mode/model/modeKinds";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { applyOutputs, retuneLighting } from "@/features/mode/modeApi";
import { isOutputsApplied, needsCalibration } from "@/features/mode/state/modeApplyOutcome";
import { choiceFailureMessage } from "@/features/shell/notices/choiceFailureMessage";
import { createRetuneCoalescer } from "@/features/mode/state/retuneCoalescer";
import { useLightingRuntime } from "@/features/mode/state/useLightingRuntime";
import {
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  normalizeEffectPayload,
  normalizeSolidColorPayload,
  type LightingModeKind,
} from "@/shared/contracts/mode";
import { LIGHTING_ORIGIN } from "@/shared/contracts/lightingRuntime";
import { PREVIEW_STATUS } from "@/shared/contracts/preview";
import { useSolidColorDraft } from "@/features/mode/ui/solid/useSolidColorDraft";
import { closePreview, setPreviewPopupHidden } from "../previewApi";
import { PopupEffectRow } from "./PopupEffectRow";
import { DEFAULT_WHITE_KELVIN, KelvinSlider } from "@/features/mode/ui/solid/SolidWhite";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { StageChoice } from "@/shared/ui/Stage/Stage";

/** Trailing window for popup-centre writes so a window drag hits disk once. */
const PERSIST_CENTER_DEBOUNCE_MS = 400;

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export function ControlPopupApp() {
  const { t } = useTranslation();
  const { snapshot, adopt } = useLightingRuntime();
  const mode = snapshot?.mode ?? null;
  const retunes = useMemo(() => createRetuneCoalescer((tuning) => retuneLighting(tuning)), []);
  const [runError, setRunError] = useState<string | null>(null);

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
  const runningEffect = kind === LIGHTING_MODE_KIND.EFFECT ? normalizeEffectPayload(mode?.effect) : null;

  // ── Solid color draft (shared HSV picker + throttled brightness) ─────────
  const incomingSolid = useMemo(
    () => ({
      r: mode?.solid?.r ?? DEFAULT_SOLID_COLOR.r,
      g: mode?.solid?.g ?? DEFAULT_SOLID_COLOR.g,
      b: mode?.solid?.b ?? DEFAULT_SOLID_COLOR.b,
      brightness: mode?.solid?.brightness ?? DEFAULT_SOLID_COLOR.brightness,
      kelvin: mode?.solid?.kelvin ?? null,
    }),
    [mode?.solid?.r, mode?.solid?.g, mode?.solid?.b, mode?.solid?.brightness, mode?.solid?.kelvin],
  );

  const handleSolidCommit = useCallback(
    (next: SolidDraft) => {
      if (!isSolid) return;
      retunes.push({ solid: normalizeSolidColorPayload(next) });
    },
    [isSolid, retunes],
  );

  // White reopens at the temperature it last had.
  const lastKelvinRef = useRef(mode?.solid?.kelvin ?? DEFAULT_WHITE_KELVIN);
  const { draft, setColor, setKelvin, setBrightness } = useSolidColorDraft({
    incoming: incomingSolid,
    onCommit: handleSolidCommit,
  });

  // ── Mode strip handlers ──────────────────────────────────────────────────
  const handleModeClick = useCallback(
    (next: LightingModeKind) => {
      setRunError(null);
      void (async () => {
        try {
          retunes.reset();
          // The kind alone for Off and Ambilight: Rust keeps the last Ambilight
          // settings. Solid carries the colour on screen.
          const result = await applyOutputs({
            mode: modeKind(next).config({
              solid: {
                r: draft.r,
                g: draft.g,
                b: draft.b,
                brightness: draft.brightness,
                ...(draft.kelvin != null ? { kelvin: draft.kelvin } : {}),
              },
            }),
            origin: LIGHTING_ORIGIN.POPUP,
          });
          adopt(result.snapshot);
          if (needsCalibration(result)) {
            setRunError(t("preview:control.calibrationRequired"));
          } else if (!isOutputsApplied(result)) {
            // Said here, in the main window's words: a choice that changed
            // nothing used to change nothing on screen either.
            const failure = choiceFailureMessage(result, t);
            if (failure !== null) {
              setRunError(failure);
              console.warn(
                `[LumaSync] ControlPopupApp mode ${next}: ${result.status.code}`,
                result.status.details ?? "",
              );
            }
          }
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp mode change failed:", error);
        }
      })();
    },
    [adopt, retunes, t, draft.r, draft.g, draft.b, draft.brightness, draft.kelvin],
  );

  // ── Close and hide ───────────────────────────────────────────────────────
  // Close ends the session in Rust, which destroys this window and the twin;
  // only a failure leaves anything here to show.
  const handleClose = useCallback(() => {
    void closePreview().then((result) => {
      if (result.status.code === PREVIEW_STATUS.CLOSE_FAILED) {
        setRunError(t("preview:status.PREVIEW_CLOSE_FAILED"));
      }
    });
  }, [t]);

  const handleHide = useCallback(() => {
    void setPreviewPopupHidden(true);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const hexColor = rgbToHex(draft);
  if (draft.kelvin != null) lastKelvinRef.current = draft.kelvin;
  const brightnessPct = Math.round(draft.brightness * 100);

  return (
    <div className="lm-control-root">
      {/* Header — draggable region */}
      <header className="lm-control-header" data-tauri-drag-region>
        <span className="lm-control-title" data-tauri-drag-region>
          {t("preview:title")}
        </span>
      </header>

      <div className="lm-control-body">
        <div>
          <div className="lm-control-section-title">{t("common:mode.title")}</div>
          <ModeStrip variant="popup" value={kind} onSelect={handleModeClick} />
        </div>

        {isSolid && (
          <div className="flex flex-col gap-3" data-testid="popup-colour">
            <StageChoice
              ariaLabel={t("lights:solid.tone")}
              value={draft.kelvin != null ? "white" : "colour"}
              onChange={(tone) =>
                tone === "white"
                  ? setKelvin(lastKelvinRef.current)
                  : setColor({ r: draft.r, g: draft.g, b: draft.b })
              }
              options={[
                { value: "colour", label: t("lights:solid.colour"), testId: "solid-tone-colour" },
                { value: "white", label: t("lights:solid.white"), testId: "solid-tone-white" },
              ]}
            />
            {draft.kelvin != null ? (
              <KelvinSlider kelvin={draft.kelvin} onChange={setKelvin} />
            ) : (
              <div className="flex justify-center">
                <HsvColorPicker
                  value={hexColor}
                  onChange={(hex) => {
                    const rgb = parseHex(hex);
                    if (rgb) setColor(rgb);
                  }}
                  ariaLabel={t("common:mode.solidColor")}
                  compact
                />
              </div>
            )}
            <RangeRow
              variant="stage"
              label={t("common:mode.brightness")}
              valueLabel={`${brightnessPct}%`}
              min={0}
              max={100}
              step={1}
              value={brightnessPct}
              onChange={(v) => setBrightness(v / 100)}
              testId="popup-brightness"
            />
          </div>
        )}

        {runningEffect && (
          <PopupEffectRow
            effect={runningEffect}
            onBrightness={(brightness) => retunes.push({ effect: { ...runningEffect, brightness } })}
          />
        )}

        {runError && (
          <p className="font-mono text-[10px] leading-snug text-red" role="alert">
            {runError}
          </p>
        )}

        <p className="lm-control-drag-hint">{t("preview:control.dragHint")}</p>
      </div>

      <footer className="lm-test-footer is-idle">
        <span className="lm-test-footer-text" />
        <button
          type="button"
          className="lm-control-close"
          onClick={handleHide}
          title={t("preview:control.hideHint")}
        >
          {t("preview:control.hide")}
        </button>
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
