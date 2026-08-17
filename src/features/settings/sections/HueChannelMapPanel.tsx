import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import {
  CHANNEL_WRITEBACK_STATUS,
  findHueChannel,
  type HueChannelPlacement,
  type HueZone,
} from "@/shared/contracts/roomMap";
import { HUE_AREA_CHANNELS_STATUS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import { updateHueChannelPositions } from "@/features/room-map/roomMapApi";
import {
  moveHueChannelToWorld,
  resolveHueChannelWorld,
  resolveHueChannelWorldZ,
} from "@/features/room-map/model/hueChannelPosition";
import {
  HUE_REGION_PRESETS,
  HUE_REGION_PRESET_POSITIONS,
  isBridgePosition,
  matchRegionPreset,
  type HueRegionPreset,
} from "@/features/hue/model/regionPresets";

interface Props {
  channels: HueAreaChannelInfo[];
  isLoading: boolean;
  /** Last fetch's status code, `null` before the first answer. An empty area and
   * a bridge that never replied both arrive as an empty list. */
  channelsStatus?: string | null;
  /** Persisted channel placements from shellStore. Falls back to bridge positionX/Y when absent. */
  placements?: HueChannelPlacement[];
  /** Called when any channel position changes. */
  onPositionChange?: (updated: HueChannelPlacement[]) => void;
  /** When true, renders an inline amber error message under the rows. */
  persistError?: boolean;
  /** Bridge IP for write-back (CHAN-05). */
  bridgeIp?: string;
  /** Hue application key for write-back (CHAN-05). `""` means "resolve from
   * the OS keychain"; only `undefined` means no pairing exists. */
  username?: string;
  /** Entertainment area ID for write-back (CHAN-05). */
  areaId?: string;
  /** When true, the save-to-bridge button is disabled with tooltip. */
  isStreaming?: boolean;
  /** Room-map Hue zones. A channel bound to one stores its position relative to
   *  the zone, so editing here has to project through it rather than write the
   *  absolute pair the runtime ignores. */
  zones?: readonly HueZone[];
}

const NO_ZONES: readonly HueZone[] = [];

const SAVED_FLASH_MS = 2000;

/** Convert Hue position (x: -1..+1, y: -1..+1) to CSS % inside the grid box.
 *  Hue x: -1=left, +1=right → left%
 *  Hue y: -1=bottom, +1=top → we flip so top of box = top of screen
 */
export function posToPercent(x: number, y: number): { left: string; top: string } {
  const left = `${((x + 1) / 2) * 100}%`;
  const top = `${((1 - y) / 2) * 100}%`; // flip Y axis
  return { left, top };
}

/** The saved record for a bridge channel, or a fresh one seeded from the bridge.
 *  Returning the whole record is the point — handing back a `{x,y,z}` triple is
 *  what let the caller rebuild a four-field literal and drop `zoneId`. */
function resolvePlacement(
  ch: HueAreaChannelInfo,
  placements: HueChannelPlacement[],
  zones: readonly HueZone[],
): HueChannelPlacement {
  const saved = findHueChannel(placements, ch.index);
  // Stamped on both branches: this is the only place a placement meets the live
  // channel it belongs to, so it is the only place the bridge's own id can be
  // learned. Without it the write-back has nothing to address and refuses.
  if (!saved) {
    return {
      channelIndex: ch.index,
      channelId: ch.channelId,
      x: ch.positionX,
      y: ch.positionY,
      z: 0,
    };
  }
  // Presets edit world coordinates, so a bound channel's absolute pair is
  // refreshed from its zone before it is shown.
  const world = resolveHueChannelWorld(saved, zones);
  return {
    ...saved,
    channelId: ch.channelId,
    x: world.x,
    y: world.y,
    z: resolveHueChannelWorldZ(saved, zones),
  };
}

/** Region → token-backed CSS color. Shared with `MiniSpatialPreview` so the
 *  room list dots read as members of the same family. */
const REGION_COLOR_VAR: Record<string, string> = {
  left: "var(--lm-zone-1)",
  right: "var(--lm-zone-3)",
  top: "var(--lm-zone-2)",
  bottom: "var(--lm-amber)",
  center: "var(--lm-ink-faint)",
};

const NEUTRAL_DOT = "var(--lm-ink-faint)";

/** Spelled out rather than interpolated: a template-built key is invisible to
 *  the orphan ratchet, which then green-lights deleting a live string. */
const PRESET_LABEL_KEY = {
  left: "hue:channelMap.regions.left",
  right: "hue:channelMap.regions.right",
  top: "hue:channelMap.regions.top",
  bottom: "hue:channelMap.regions.bottom",
  center: "hue:channelMap.regions.center",
} as const satisfies Record<HueRegionPreset, string>;

const EMPTY_STATE_KEYS = {
  empty: {
    heading: "hue:channelMap.state.emptyHeading",
    body: "hue:channelMap.state.emptyBody",
  },
  unreachable: {
    heading: "hue:channelMap.state.unreachableHeading",
    body: "hue:channelMap.state.unreachableBody",
  },
  failed: {
    heading: "hue:channelMap.state.failedHeading",
    body: "hue:channelMap.state.failedBody",
  },
} as const;

export function HueChannelMapPanel({
  channels,
  isLoading,
  channelsStatus,
  placements,
  onPositionChange,
  persistError,
  bridgeIp,
  username,
  areaId,
  isStreaming = false,
  zones = NO_ZONES,
}: Props) {
  const { t } = useTranslation();

  // Stable refs so the effects below do not cycle on new array identities.
  const placementsRef = useRef<HueChannelPlacement[]>(placements ?? []);
  placementsRef.current = placements ?? [];

  const zonesRef = useRef<readonly HueZone[]>(zones);
  zonesRef.current = zones;

  const [savedChannelIndex, setSavedChannelIndex] = useState<number | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; code?: string; message?: string } | null>(null);
  const saveResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>(() =>
    channels.map((ch) => resolvePlacement(ch, placementsRef.current, zonesRef.current)),
  );

  // Re-initialize when channels change (area switch). placementsRef read via ref to avoid cycle.
  useEffect(() => {
    setChannelPlacements(
      channels.map((ch) => resolvePlacement(ch, placementsRef.current, zonesRef.current)),
    );
  }, [channels]);

  // The room map is bridge-blind — it draws persisted placements only, so a real
  // channel stayed invisible there until placed here. The parent's write
  // refreshes `placements`, so the second pass finds nothing missing.
  useEffect(() => {
    if (!onPositionChange || channels.length === 0) return;
    const resolved = channels.map((ch) =>
      resolvePlacement(ch, placementsRef.current, zonesRef.current),
    );
    const missing = resolved.some((p) => {
      const stored = findHueChannel(placementsRef.current, p.channelIndex);
      return !stored || stored.channelId !== p.channelId;
    });
    if (missing) onPositionChange(resolved);
  }, [channels, onPositionChange]);

  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      if (saveResultTimerRef.current !== null) clearTimeout(saveResultTimerRef.current);
    },
    [],
  );

  const flashSaved = useCallback((channelIndex: number) => {
    setSavedChannelIndex(channelIndex);
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => {
      setSavedChannelIndex(null);
      savedTimerRef.current = null;
    }, SAVED_FLASH_MS);
  }, []);

  /** A preset writes a position, not a label. Everything downstream — the row's
   *  own state, the room map, the frame loop — reads only the position. */
  const applyPosition = useCallback(
    (channelIndex: number, x: number, y: number) => {
      const next = channelPlacements.map((p) =>
        p.channelIndex === channelIndex
          ? moveHueChannelToWorld(p, zonesRef.current, x, y)
          : p,
      );
      setChannelPlacements(next);
      onPositionChange?.(next);
      flashSaved(channelIndex);
    },
    [channelPlacements, onPositionChange, flashSaved],
  );

  const handleSaveToBridge = useCallback(async () => {
    if (!bridgeIp || username === undefined || !areaId) return;
    const confirmed = window.confirm(t("hue:channelMap.saveConfirm", { ip: bridgeIp }));
    if (!confirmed) return;

    setIsSaving(true);
    setSaveResult(null);
    if (saveResultTimerRef.current !== null) {
      clearTimeout(saveResultTimerRef.current);
      saveResultTimerRef.current = null;
    }

    try {
      const response = await updateHueChannelPositions({
        channels: channelPlacements,
        bridgeIp,
        username,
        areaId,
      });
      if (response.code === HUE_RUNTIME_STATUS.CHANNEL_POSITIONS_UPDATED) {
        setSaveResult({ ok: true });
        saveResultTimerRef.current = setTimeout(() => {
          setSaveResult(null);
          saveResultTimerRef.current = null;
        }, 3000);
      } else {
        setSaveResult({ ok: false, code: response.code, message: response.message });
      }
    } catch (err) {
      console.error("[LumaSync] Hue channel-position write-back failed:", err);
      setSaveResult({
        ok: false,
        code: CHANNEL_WRITEBACK_STATUS.NETWORK_ERROR,
        message: String(err),
      });
    } finally {
      setIsSaving(false);
    }
  }, [bridgeIp, username, areaId, channelPlacements, t]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const frame = (body: React.ReactNode) => (
    <section
      className="lm-settings-group lm-chmap"
      role="region"
      aria-label={t("hue:channelMap.title")}
    >
      <div className="lm-settings-group-h">
        <span className="t">{t("hue:channelMap.title")}</span>
      </div>
      {body}
    </section>
  );

  if (isLoading) {
    return frame(
      <div className="lm-chmap-body">
        <p className="lm-chmap-hint">{t("hue:channelMap.loading")}</p>
      </div>,
    );
  }

  if (channels.length === 0) {
    // Three different facts arrive as the same empty list, and one "no channels"
    // line for all of them is what made a dropped bridge look like an empty area.
    if (channelsStatus === undefined || channelsStatus === null) return null;
    const state =
      channelsStatus === HUE_AREA_CHANNELS_STATUS.EMPTY
        ? "empty"
        : channelsStatus === HUE_AREA_CHANNELS_STATUS.UNREACHABLE
          ? "unreachable"
          : "failed";
    const keys = EMPTY_STATE_KEYS[state];
    return frame(
      <div className="lm-chmap-body">
        <div className={`lm-chmap-state is-${state}`} role="status">
          <span className="lm-chmap-state-h">{t(keys.heading)}</span>
          <span className="lm-chmap-state-b">{t(keys.body)}</span>
        </div>
      </div>,
    );
  }

  const isStale = channelsStatus === HUE_AREA_CHANNELS_STATUS.UNREACHABLE;
  const hasSaveAction = Boolean(bridgeIp && areaId) && username !== undefined;

  return (
    <section
      className={`lm-settings-group lm-chmap${isStale ? " is-stale" : ""}`}
      role="region"
      aria-label={t("hue:channelMap.title")}
    >
      <div className="lm-settings-group-h">
        <span className="t">{t("hue:channelMap.title")}</span>
      </div>

      <div className="lm-chmap-body">
        <p className="lm-chmap-hint">
          <span className="lm-chmap-hint-text">{t("hue:channelMap.hint")}</span>
        </p>

        {isStale && (
          <div className="lm-chmap-state is-unreachable" role="status">
            <span className="lm-chmap-state-b">{t("hue:channelMap.state.staleBody")}</span>
          </div>
        )}

        {persistError && (
          <div className="lm-chmap-feedback is-warn" role="alert">
            <span>{t("hue:channelMap.saveError")}</span>
          </div>
        )}
      </div>

      <div className="lm-chmap-rows">
        {channels.map((ch) => {
          const placement =
            findHueChannel(channelPlacements, ch.index) ??
            resolvePlacement(ch, placementsRef.current, zonesRef.current);
          const matched = matchRegionPreset(placement.x, placement.y);
          const fromBridge = isBridgePosition(placement.x, placement.y, ch.positionX, ch.positionY);
          const dotColor = matched ? (REGION_COLOR_VAR[matched] ?? NEUTRAL_DOT) : NEUTRAL_DOT;
          const isSaved = savedChannelIndex === ch.index;
          // The bridge's own id, rendered raw: `#0` is a legitimate channel.
          const idLabel = `#${ch.channelId}`;

          return (
            <div
              key={ch.index}
              className="lm-chmap-row"
              role="group"
              aria-label={t("hue:channelMap.regionRowAriaLabel", { index: idLabel })}
            >
              <div className="lm-chmap-row-id">
                <span
                  className="lm-chmap-row-dot"
                  style={{ ["--lm-chmap-dot-color" as string]: dotColor }}
                  aria-hidden
                />
                <span className="lm-chmap-row-num">{idLabel}</span>
                <span className="lm-chmap-row-lights">
                  {ch.lightCount === 1
                    ? t("hue:channelMap.oneLight")
                    : t("hue:channelMap.lights", { count: ch.lightCount })}
                </span>
              </div>

              <div
                className="lm-chmap-pills"
                role="radiogroup"
                aria-label={t("hue:channelMap.zonePicker")}
              >
                {HUE_REGION_PRESETS.map((preset: HueRegionPreset) => {
                  const isActive = matched === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      className={`lm-chmap-pill${isActive ? " is-active" : ""}${
                        isActive && fromBridge ? " is-derived" : ""
                      }`}
                      onClick={() => {
                        const target = HUE_REGION_PRESET_POSITIONS[preset];
                        applyPosition(ch.index, target.x, target.y);
                      }}
                    >
                      {t(PRESET_LABEL_KEY[preset])}
                    </button>
                  );
                })}
              </div>

              <div className="lm-chmap-row-trail">
                {matched === null && (
                  <span className="lm-chmap-row-custom">{t("hue:channelMap.custom")}</span>
                )}
                {isSaved ? (
                  <span className="lm-chmap-row-saved" aria-live="polite">
                    {t("hue:channelMap.saved")}
                  </span>
                ) : !fromBridge ? (
                  <button
                    type="button"
                    className="lm-chmap-row-reset"
                    title={t("hue:channelMap.resetToBridgeTitle")}
                    onClick={() => {
                      applyPosition(ch.index, ch.positionX, ch.positionY);
                    }}
                  >
                    {t("hue:channelMap.resetToBridge")}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {hasSaveAction && (
        <div className="lm-chmap-footer">
          <div className="lm-chmap-footer-row">
            <span className="lm-chmap-beta">{t("hue:channelMap.beta")}</span>
            <div className="lm-chmap-footer-spacer" />
            <button
              type="button"
              className="lm-device-btn is-primary"
              disabled={isStreaming || isSaving || isStale}
              title={
                isStale
                  ? t(EMPTY_STATE_KEYS.unreachable.heading)
                  : isStreaming
                    ? t("hue:channelMap.saveToBridgeTooltip")
                    : undefined
              }
              onClick={() => {
                void handleSaveToBridge();
              }}
            >
              {isSaving ? t("hue:channelMap.saving") : t("hue:channelMap.saveToBridge")}
            </button>
          </div>
          {saveResult !== null &&
            (saveResult.ok ? (
              <div className="lm-chmap-feedback is-ok" role="status" aria-live="polite">
                <span>{t("hue:channelMap.savedToBridge")}</span>
              </div>
            ) : (
              <div className="lm-chmap-feedback is-err" role="alert">
                <span>{t("hue:channelMap.saveToBridgeError", { code: saveResult.code ?? "" })}</span>
                <button
                  type="button"
                  className="lm-chmap-feedback-retry"
                  onClick={() => {
                    void handleSaveToBridge();
                  }}
                >
                  {t("hue:channelMap.saveToBridgeErrorRetry")}
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// MiniSpatialPreview — kept token-aligned with the row dots so the room list
// reads as part of the same family.
// ---------------------------------------------------------------------------

/** Minimal channel shape required for MiniSpatialPreview dot rendering. */
interface MiniChannelShape {
  positionX: number;
  positionY: number;
  autoRegion?: string;
  index?: number;
}

export function MiniSpatialPreview({
  channels,
  channelCount,
}: {
  channels?: MiniChannelShape[];
  channelCount?: number;
}) {
  const placeholderCount = channelCount ?? 0;

  return (
    <div className="lm-chmap-canvas" style={{ height: 48, borderRadius: 6 }} aria-hidden="true">
      <div className="lm-chmap-canvas-axis is-v" />
      <div className="lm-chmap-canvas-axis is-h" />
      {channels
        ? channels.map((ch, i) => {
            const { left, top } = posToPercent(ch.positionX, ch.positionY);
            const dotColor = REGION_COLOR_VAR[ch.autoRegion ?? "center"] ?? NEUTRAL_DOT;
            return (
              <span
                key={ch.index ?? i}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 8,
                  height: 8,
                  marginLeft: -4,
                  marginTop: -4,
                  borderRadius: "50%",
                  background: dotColor,
                }}
              />
            );
          })
        : Array.from({ length: placeholderCount }, (_, i) => {
            const x = placeholderCount > 1 ? (i / (placeholderCount - 1)) * 2 - 1 : 0;
            const { left, top } = posToPercent(x, 0);
            return (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 8,
                  height: 8,
                  marginLeft: -4,
                  marginTop: -4,
                  borderRadius: "50%",
                  background: "var(--lm-ink-faint, #4d5564)",
                }}
              />
            );
          })}
    </div>
  );
}
