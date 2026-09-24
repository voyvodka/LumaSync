import type { LocalSink } from "@/features/device/localSink";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation, Trans } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "@/features/mode/state/modeGuard";
import {
  DEFAULT_SOLID_COLOR,
  LIGHTING_MODE_KIND,
  OUTPUT_TARGETS,
  normalizeLightingModeConfig,
  normalizeAmbilightPayload,
  type LightingModeConfig,
} from "@/shared/contracts/mode";
import {
  SCENE_PRESETS,
  findMatchingScenePreset,
  type ScenePreset,
} from "@/features/mode/model/scenePresets";
import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import { rgbToHex } from "@/shared/lib/color";
import { roomAwareStatus } from "@/features/room-map/model/roomAware";
import { RoomAwareIndicator } from "@/features/room-map/ui/RoomAwareIndicator";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";
import {
  FIRMWARE_PROFILE,
  type ColorCorrectionConfig,
  type FirmwareProfile,
} from "@/shared/contracts/device";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { useRuntimeHealth } from "@/features/telemetry/runtimeHealthSource";
import { hasSerialLinkBudget, type RuntimeHealth } from "@/shared/contracts/telemetry";
import { shallowEqual } from "@/shared/lib/store";
import { HUE_STREAM_MAX_HZ } from "@/features/hue/model/streamRate";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import {
  hueUnavailableReason,
  type HueUnavailableReason,
} from "@/features/hue/model/hueAvailability";
import { shellStore } from "@/features/persistence/shellStore";
import { outputAvailability } from "@/features/mode/model/outputAvailability";
import { MODE_KINDS } from "@/features/mode/model/modeKinds";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { Callout } from "@/shared/ui/Callout";
import { RangeRow } from "@/shared/ui/RangeRow";
import { Toggle } from "@/shared/ui/Toggle";

import { SolidColorPanel } from "./control/SolidColorPanel";
import { ColorCorrectionPanel } from "./control/ColorCorrectionPanel";
import { LightingSmoothingPresetControl } from "./control/LightingSmoothingPresetControl";

const selectLinkBudget = (health: RuntimeHealth) => ({
  linkConstrained: health.linkConstrained,
  linkMaxFps: health.linkMaxFps,
});

const HUE_UNAVAILABLE_SUB_KEYS = {
  notConfigured: "lights:dock.rows.hueSubUnavailable",
  keyRejected: "lights:dock.rows.hueSubKeyRejected",
  unreachable: "lights:dock.rows.hueSubUnreachable",
  checking: "lights:dock.rows.hueSubChecking",
} as const satisfies Record<HueUnavailableReason, string>;

/** Why the Hue row is unavailable; only called when it is. Before boot has
 * read the saved pairing, "not paired" would be a guess, so it says checking. */
export function hueUnavailableSubKey(
  hueConfigured: boolean,
  verdict: HueProbeVerdict | null,
  bootstrapDone: boolean,
): (typeof HUE_UNAVAILABLE_SUB_KEYS)[HueUnavailableReason] {
  if (!bootstrapDone) return HUE_UNAVAILABLE_SUB_KEYS.checking;
  return HUE_UNAVAILABLE_SUB_KEYS[hueUnavailableReason(hueConfigured, false, verdict) ?? "checking"];
}

interface OutputRowView {
  available: boolean;
  /** A live stream state the row reports while selected. */
  liveState?: "is-reconnecting" | "is-failed";
  name: string;
  detail: string;
  detailLang?: string;
  sub: ReactNode;
}

interface LightsSectionProps {
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  /** Any local output — serial strip or WLED panel — is bound. */
  localOutputConnected: boolean;
  /** Which one, so the row can name it rather than always saying USB. */
  localSink: LocalSink | null;
  hueConfigured: boolean;
  /** The shell boot has settled; until then `hueConfigured: false` is not yet known. */
  bootstrapDone?: boolean;
  hueReachable?: boolean;
  /** What the last bridge probe found; picks the unavailable row's wording. */
  hueProbeVerdict?: HueProbeVerdict | null;
  hueStreaming: boolean;
  /** Hue session owned but the backend is retrying the bridge; overrides `hueStreaming`. */
  hueReconnecting?: boolean;
  /** The backend reports the Hue stream Failed: the retries are over. */
  hueStreamFailed?: boolean;
  calibration?: LedCalibrationConfig;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  /** The dock's "+": outputs are added on Devices. */
  onAddOutput?: () => void;
}

export function LightsSection({
  mode,
  outputTargets,
  localOutputConnected,
  localSink,
  hueConfigured,
  bootstrapDone = true,
  hueReachable = true,
  hueProbeVerdict = null,
  hueStreaming,
  hueReconnecting = false,
  hueStreamFailed = false,
  calibration,
  modeLockReason,
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onAddOutput,
}: LightsSectionProps) {
  const { t } = useTranslation();
  // Why the mode buttons are dim — calibration, no output, still checking — is
  // said by the shell notice queue, not here (docs/architecture/ui-and-shell.md).
  const calibrationLocked = modeLockReason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  const modeSelectorDisabled = calibrationLocked || isModeTransitioning;
  // Without a reachable sink an activated mode spins up a worker with nowhere to
  // send frames; a configured-but-offline bridge is not one. One still being
  // checked is not one yet either, but it is not "missing" — see CompactLayout.
  const availability = outputAvailability({
    localOutputConnected,
    hueConfigured,
    hueReachable,
    hueProbeVerdict,
    bootstrapDone,
  });
  const nonOffModeDisabled = modeSelectorDisabled || availability !== "ready";
  const normalizedMode = normalizeLightingModeConfig(mode);
  const activeKind = normalizedMode.kind;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const incomingSolid = normalizedMode.solid ?? DEFAULT_SOLID_COLOR;
  const incomingAmbilight = normalizeAmbilightPayload(normalizedMode.ambilight);

  const solidHex = rgbToHex(incomingSolid);
  const solidBrightnessPct = Math.round(incomingSolid.brightness * 100);

  // Scene selection is derived from the active SOLID color, not stored
  // locally — that keeps the highlight in sync with the persisted mode
  // across reloads and across the Compact/Lights views.
  const activeScenePreset = isSolid ? findMatchingScenePreset(incomingSolid) : undefined;

  // ── v1.4 persisted device/runtime knobs ──────────────────────────────
  // Hydrated once from shellStore and refreshed through the child control
  // callbacks. Kept in state here so the LED advanced-settings panels +
  // the SolidColorPanel brightness lock stay in sync without prop drilling
  // through App.tsx for every knob.
  const [initialColorCorrection, setInitialColorCorrection] =
    useState<ColorCorrectionConfig | undefined>(undefined);
  // Chosen on Devices → USB; read here only for the Adalight brightness lock.
  // Sections mount one at a time, so returning here re-reads it.
  const [firmwareProfile, setFirmwareProfile] = useState<FirmwareProfile | undefined>(undefined);
  const [initialHueIntensityPreset, setInitialHueIntensityPreset] =
    useState<HueIntensityPreset | undefined>(undefined);
  const [advancedHydrated, setAdvancedHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setInitialColorCorrection(state.colorCorrection);
        setFirmwareProfile(state.firmwareProfile);
        setInitialHueIntensityPreset(state.lightingIntensityPreset);
        setAdvancedHydrated(true);
      })
      .catch((error) => {
        console.error(
          "[LumaSync] LightsSection advanced-settings hydrate failed:",
          error,
        );
        if (!cancelled) setAdvancedHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read once on mount: the room map is a different section, so returning
  // here from an edit remounts this one.
  const [tvAnchor, setTvAnchor] = useState<TvAnchorPlacement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void shellStore.load().then((state) => {
      if (cancelled) return;
      setTvAnchor(state.roomMap?.tvAnchor ?? null);
    }).catch((error) => {
      console.error("[LumaSync] LightsSection tvAnchor hydrate failed:", error);
    });
    return () => { cancelled = true; };
  }, []);


  const isAdalight = firmwareProfile === FIRMWARE_PROFILE.ADALIGHT;

  const handleScenePresetClick = (preset: ScenePreset) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.SOLID,
      solid: {
        r: preset.r,
        g: preset.g,
        b: preset.b,
        brightness: isSolid ? incomingSolid.brightness : preset.brightness,
      },
    });
  };

  const usbSelected = outputTargets.includes("usb");
  const hueAvailable = hueConfigured && hueReachable;
  const roomAware = roomAwareStatus(tvAnchor, outputTargets, {
    configured: hueConfigured,
    reachable: hueReachable,
    verdict: hueProbeVerdict,
  });

  const toggleTarget = (id: HueRuntimeTarget, currentlySelected: boolean) => {
    const next = currentlySelected
      ? outputTargets.filter((target) => target !== id)
      : [...outputTargets, id];
    if (next.length > 0) onOutputTargetsChange(next);
  };

  const toggleBlackBorder = () => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: {
        ...incomingAmbilight,
        blackBorderDetection: !incomingAmbilight.blackBorderDetection,
      },
    });
  };

  // Slider shows saturation as a 50–200% dial; payload is a 0.5–2.0 factor.
  const handleSaturationChange = (percent: number) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { ...incomingAmbilight, saturation: percent / 100 },
    });
  };

  // Ambilight brightness used to live only in the
  // CompactLayout. Mirrored here so the full-mode Lights view exposes
  // the same control set; payload field is `ambilight.brightness`
  // (0..1 unit), surfaced as a 0..100% dial.
  const handleAmbilightBrightnessChange = (percent: number) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { ...incomingAmbilight, brightness: percent / 100 },
    });
  };
  const ambilightBrightnessPct = Math.round((incomingAmbilight.brightness ?? 1) * 100);

  const totalLeds = calibration?.totalLeds;

  // Pushed by the worker, not polled: the note shows with stats for nerds off.
  const linkBudget = useRuntimeHealth(selectLinkBudget, shallowEqual);

  // Gate on the flag, never on `linkMaxFps < 30` — the 0 sentinel means "no
  // serial link this session", so a raw comparison would paint every Hue-only
  // and WLED-only session as maximally constrained.
  const linkConstrained =
    isAmbilight && usbSelected && hasSerialLinkBudget(linkBudget) && linkBudget.linkConstrained;

  const saturationValue = Math.round((incomingAmbilight.saturation ?? 1) * 100);
  const blackBorderOn = incomingAmbilight.blackBorderDetection ?? false;

  const slidersDisabled = !isAmbilight || modeSelectorDisabled;
  // Adalight (firmware-fixed brightness) gets the same lock parity as
  // SolidColorPanel. Locking is OR-ed with the standard slider disable
  // so the slider tooltip surfaces the firmware reason while transient
  // mode-transition disables stay generic.
  const ambilightBrightnessLocked = isAdalight || slidersDisabled;

  // One dock row per output target: a new target fails to compile until it has one.
  const outputRows = {
    usb: {
      available: localOutputConnected,
      name:
        localSink?.transport === "wled"
          ? t("lights:dock.rows.wledName")
          : t("lights:dock.rows.usbName"),
      // The identity of the thing actually bound. For WLED that is its LAN
      // address — the persisted sink config keeps no friendly name — and for
      // serial it is the USB product string the OS reported, when it reported
      // one. Both are device-supplied, so they are uppercased by English rules
      // — "CH340 USB SERİAL" under `lang="tr"` otherwise.
      detail:
        localSink?.transport === "wled"
          ? localSink.id
          : (localSink?.product ?? t("lights:dock.rows.usbType")),
      detailLang: localSink?.transport === "wled" || localSink?.product ? "en" : undefined,
      sub: localOutputConnected ? (
        <Trans
          i18nKey={
            localSink?.transport === "wled" ? "lights:dock.rows.wledSub" : "lights:dock.rows.usbSub"
          }
          values={{ count: totalLeds ?? 0 }}
          components={{ b: <b /> }}
        />
      ) : (
        t("lights:dock.rows.usbSubUnavailable")
      ),
    },
    hue: {
      available: hueAvailable,
      liveState: hueReconnecting ? "is-reconnecting" : hueStreamFailed ? "is-failed" : undefined,
      name: t("lights:dock.rows.hueName"),
      detail: t("lights:dock.rows.hueType"),
      sub: !hueAvailable ? (
        <Trans
          i18nKey={hueUnavailableSubKey(hueConfigured, hueProbeVerdict, bootstrapDone)}
          components={{ b: <b /> }}
        />
      ) : hueReconnecting ? (
        <Trans i18nKey="lights:dock.rows.hueSubReconnecting" components={{ b: <b /> }} />
      ) : hueStreamFailed ? (
        <Trans i18nKey="lights:dock.rows.hueSubFailed" components={{ b: <b /> }} />
      ) : hueStreaming ? (
        <Trans
          i18nKey="lights:dock.rows.hueSubStreaming"
          values={{ hz: HUE_STREAM_MAX_HZ }}
          components={{ b: <b /> }}
        />
      ) : (
        <Trans i18nKey="lights:dock.rows.hueSubIdle" components={{ b: <b /> }} />
      ),
    },
  } satisfies Record<HueRuntimeTarget, OutputRowView>;
  const liveSelectedCount = outputTargets.filter((target) => outputRows[target].available).length;

  return (
    <div className="lm-lights-page">
      {/* ── Center column ─────────────────────────────────────────────── */}
      <div className="lm-lights-center">
        {/* Mode strip */}
        <div>
          <div className="lm-lights-slab">
            {t("lights:slab.modeText")} <b>{t("lights:slab.modeAccent")}</b>
          </div>
          <ModeStrip
            variant="full"
            value={activeKind}
            isDisabled={(kind) =>
              kind === LIGHTING_MODE_KIND.OFF ? modeSelectorDisabled : nonOffModeDisabled
            }
            subtitles={{
              [LIGHTING_MODE_KIND.OFF]: t("lights:mode.off.subtitle"),
              [LIGHTING_MODE_KIND.AMBILIGHT]:
                typeof totalLeds === "number" && totalLeds > 0
                  ? t("lights:mode.ambilight.subtitle", { count: totalLeds })
                  : t("lights:mode.ambilight.subtitleFallback"),
              [LIGHTING_MODE_KIND.SOLID]: t("lights:mode.solid.subtitle", {
                hex: solidHex.toUpperCase(),
                brightness: solidBrightnessPct,
              }),
            }}
            onSelect={(kind) =>
              onModeChange(
                MODE_KINDS[kind].config({ solid: { ...incomingSolid }, ambilight: incomingAmbilight }),
              )
            }
          />
        </div>

        {/* Solid color picker — inline when solid mode is active */}
        {isSolid && (
          <div
            style={{
              background: "var(--lm-panel)",
              border: "1px solid var(--lm-line)",
              borderRadius: 10,
              padding: 14,
            }}
          >
            <SolidColorPanel
              incoming={incomingSolid}
              disabled={calibrationLocked}
              brightnessDisabled={isAdalight}
              brightnessDisabledReason={
                isAdalight
                  ? t("lights:led.firmwareProfile.brightnessDisabledTooltip")
                  : undefined
              }
              onCommit={(draft) =>
                onModeChange({ kind: LIGHTING_MODE_KIND.SOLID, solid: draft })
              }
            />
          </div>
        )}

        {/* Ambilight tuning — only when Ambilight is active */}
        {isAmbilight && <div>
          <div className="lm-lights-slab">
            {t("lights:slab.modeSettingsText")} <b>{t("lights:slab.modeSettingsAccent")}</b>
          </div>
          <div className="lm-signal">
            {advancedHydrated && (
              <LightingSmoothingPresetControl
                initialPreset={initialHueIntensityPreset}
                onPresetChange={setInitialHueIntensityPreset}
              />
            )}
            <div className="lm-profile">
              {/* Brightness — wired to AmbilightPayload.brightness (0..1).
                  Adalight firmware does not carry a brightness byte, so the
                  control falls into a visible-but-disabled state with the
                  shared firmware-profile tooltip — same parity logic as
                  the SolidColorPanel brightness slider. */}
              <RangeRow
                variant="profile"
                label={t("lights:signal.profile.brightness")}
                valueLabel={`${ambilightBrightnessPct}%`}
                min={0}
                max={100}
                step={1}
                value={ambilightBrightnessPct}
                disabled={ambilightBrightnessLocked}
                title={
                  isAdalight
                    ? t("lights:led.firmwareProfile.brightnessDisabledTooltip")
                    : undefined
                }
                onChange={handleAmbilightBrightnessChange}
              />
              {/* Saturation — wired to AmbilightPayload.saturation (0.5–2.0). */}
              <RangeRow
                variant="profile"
                label={t("lights:signal.profile.saturation")}
                valueLabel={`${saturationValue}%`}
                min={50}
                max={200}
                step={1}
                value={saturationValue}
                disabled={slidersDisabled}
                onChange={handleSaturationChange}
              />
              {/* Black border — toggle */}
              <div className="lm-psl is-toggle">
                <div className="row">
                  <span>{t("lights:signal.profile.blackBorder")}</span>
                  <b>
                    {blackBorderOn
                      ? t("lights:signal.profile.blackBorderAuto")
                      : t("lights:signal.profile.blackBorderOff")}
                  </b>
                </div>
                <div className="tr">
                  <Toggle
                    className="tr-toggle"
                    disabled={slidersDisabled}
                    checked={blackBorderOn}
                    label={t("lights:signal.profile.blackBorder")}
                    onChange={toggleBlackBorder}
                  >
                    <div className="tr-track" style={{ width: "100%" }}>
                      <span
                        className="tr-fill"
                        style={{ width: blackBorderOn ? "100%" : "0%" }}
                      />
                    </div>
                  </Toggle>
                </div>
              </div>
            </div>
            {/* role="status", never "alert": `linkMaxFps` is derived once at
                worker start from LED count + chip type and never re-sampled,
                so this is a steady-state condition, announced once. */}
            {linkConstrained ? (
              <Callout tone="warning" className="lm-signal-note">
                {t("lights:signal.linkBudget.constrained", {
                  fps: Math.round(linkBudget.linkMaxFps),
                })}{" "}
                {t("lights:signal.linkBudget.hint")}
              </Callout>
            ) : null}
          </div>
        </div>}

        {/* Scene presets — click switches to SOLID with the preset RGB.
            Highlight is derived from the active solid color so it stays
            in sync after reloads and Compact-view edits. */}
        <div>
          <div className="lm-lights-slab">
            {t("lights:slab.scenesText")} <b>{t("lights:slab.scenesAccent")}</b>
          </div>
          <div className="lm-scenes">
            {SCENE_PRESETS.map((preset) => {
              const isSelected = activeScenePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={nonOffModeDisabled}
                  className="lm-sc"
                  style={{ background: preset.gradient }}
                  aria-pressed={isSelected}
                  onClick={() => handleScenePresetClick(preset)}
                >
                  <b>{t(preset.labelKey)}</b>
                </button>
              );
            })}
          </div>
        </div>

        {/* v1.4 advanced LED / Hue controls.
            Hydrated asynchronously so `initial*` props are defined before
            the child components mount — a bare mount with undefined
            initial values would cause the children to flash the DEFAULT
            config for one frame before the async read lands. */}
        {advancedHydrated && (
          <ColorCorrectionPanel
            initialConfig={initialColorCorrection}
            onConfigChange={setInitialColorCorrection}
          />
        )}
      </div>

      {/* ── Right dock ────────────────────────────────────────────────── */}
      <aside className="lm-dock" aria-label={t("lights:dock.outputs")}>
        <div>
          <h4>
            <span className="t">{t("lights:dock.outputs")}</span>
            {/* Only opens Devices: it used to write an empty Hue zone at the
                room's origin, which nobody asked for. */}
            <button
              type="button"
              className="add"
              aria-label={t("lights:dock.addAria")}
              title={t("lights:dock.addAria")}
              onClick={onAddOutput}
              data-testid="lights-add-output"
            >
              +
            </button>
          </h4>
          <div className="lm-out-list">
            {OUTPUT_TARGETS.map((target) => {
              const row: OutputRowView = outputRows[target];
              const selected = outputTargets.includes(target);
              // The last output that can actually receive stays on: with USB
              // selected but unplugged, turning Hue off would leave nothing lit.
              const lastLiveOutput = selected && row.available && liveSelectedCount === 1;
              return (
                <button
                  key={target}
                  type="button"
                  className={`lm-out-row ${
                    !row.available ? "is-unavailable" : !selected ? "is-off" : (row.liveState ?? "")
                  }`}
                  disabled={modeSelectorDisabled || !row.available || lastLiveOutput}
                  onClick={() => toggleTarget(target, selected)}
                  // The saved selection is untouched; a missing output is just
                  // not shown as on, since nothing is sent to it.
                  aria-pressed={selected && row.available}
                >
                  <span className="st" />
                  <div className="tx">
                    <div className="n">
                      {row.name} <em lang={row.detailLang}>{row.detail}</em>
                    </div>
                    <div className="s">{row.sub}</div>
                  </div>
                  <span className="tg" />
                </button>
              );
            })}
            {roomAware && <RoomAwareIndicator variant="inline" status={roomAware} />}
          </div>
        </div>
      </aside>
    </div>
  );
}
