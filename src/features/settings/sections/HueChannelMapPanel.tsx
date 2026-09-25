import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import type { HueAreaChannelsRead } from "@/features/hue/model/onboardingTypes";
import {
  CHANNEL_WRITEBACK_STATUS,
  findHueChannel,
  type HueChannelPlacement,
  type HueZone,
} from "@/shared/contracts/roomMap";
import {
  HUE_AREA_CHANNELS_STATUS,
  HUE_IDENTIFY_STATUS,
  HUE_RUNTIME_STATUS,
  type HueChannelPlacementOverride,
  type HueIdentifyStatus,
} from "@/shared/contracts/hue";
import { updateHueChannelPositions } from "@/features/room-map/roomMapApi";
import {
  adoptBridgePlacement,
  resolveChannelPlacement,
  seedChannelPlacements,
} from "@/features/room-map/model/hueChannelSeeding";
import {
  HUE_SYNC_STATE,
  bridgeSnapshot,
  deriveHueSyncState,
  differingChannelIds,
  sameSnapshot,
  snapshotAfterPush,
} from "@/features/hue/model/hueSyncState";
import { parseSkippedChannelIds } from "@/features/hue/model/hueWritebackResult";
import { Button } from "@/shared/ui/Button";
import { Callout } from "@/shared/ui/Callout";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";

interface Props {
  channels: HueAreaChannelInfo[];
  isLoading: boolean;
  /** Last fetch's status code, `null` before the first answer. An empty area and
   * a bridge that never replied both arrive as an empty list. */
  channelsStatus?: string | null;
  /** `channels` was read from the bridge with the runtime idle, so its positions
   *  are the bridge's rather than our own placements echoed back. */
  channelsFromBridge?: boolean;
  /** Persisted channel placements from shellStore. Falls back to bridge positionX/Y when absent. */
  placements?: HueChannelPlacement[];
  /** Called when any channel position changes. */
  onPositionChange?: (updated: HueChannelPlacement[]) => void;
  /** When true, renders an inline error under the rows. */
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
  /** The bridge's arrangement as last known for this area. Absent ⇒ never read
   *  or written from here. */
  syncedPositions?: HueChannelPlacementOverride[];
  /** Record the bridge's arrangement after a push, a pull, or a fresh read. */
  onSyncedPositionsChange?: (snapshot: HueChannelPlacementOverride[]) => void;
  /** Re-read the bridge's list. The pull adopts the read it resolves with — a
   *  list fetched while a stream was running carries our own placements. */
  onRefreshChannels?: () => Promise<HueAreaChannelsRead | null>;
  /** The bridge rejected our key; start the existing re-pair flow. */
  onRepair?: () => void;
  /** Placement is authored on the room map; this is the way there. */
  onNavigateToRoomMap?: () => void;
  /** Room-map Hue zones. A channel bound to one stores its position relative to
   *  the zone, so editing here has to project through it rather than write the
   *  absolute pair the runtime ignores. */
  zones?: readonly HueZone[];
  /** Light id → the Hue app's name. A light missing here is shown by count. */
  lightNames?: Readonly<Record<string, string>>;
  /** Blinks a channel's lights once. Absent ⇒ no Identify buttons. */
  onIdentify?: (lightIds: string[]) => Promise<HueIdentifyStatus>;
}

type BridgeActionResult =
  | { kind: "identifyFailed"; code: string }
  | { kind: "saved" }
  | { kind: "savedPartial"; skippedIds: number[] }
  | { kind: "saveFailed"; code: string }
  | { kind: "pulled"; clampedIds: number[] }
  | { kind: "pullFailed" };

const NO_ZONES: readonly HueZone[] = [];
const NO_NAMES: Readonly<Record<string, string>> = {};
/** Names shown before the rest collapse into "+n". */
const NAMES_SHOWN = 2;

const SAVED_DISMISS_MS = 3000;
/** Long enough to read which channels the bridge kept. */
const DETAIL_DISMISS_MS = 8000;

/** Worth retrying as-is. The rest need a re-pair or a different area layout. */
const RETRYABLE_WRITEBACK_CODES: ReadonlySet<string> = new Set([
  CHANNEL_WRITEBACK_STATUS.NETWORK_ERROR,
  CHANNEL_WRITEBACK_STATUS.SCHEMA_REJECTED,
]);

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

function channelList(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(", ");
}

/** The channel's lights by name, or `null` while none of them has one. */
function namedLights(lightIds: readonly string[], names: Readonly<Record<string, string>>): string[] | null {
  const named = lightIds.flatMap((id) => (names[id] ? [names[id]] : []));
  return named.length > 0 ? named : null;
}

export function HueChannelMapPanel({
  channels,
  isLoading,
  channelsStatus,
  channelsFromBridge = false,
  placements,
  onPositionChange,
  persistError,
  bridgeIp,
  username,
  areaId,
  isStreaming = false,
  syncedPositions,
  onSyncedPositionsChange,
  onRefreshChannels,
  onRepair,
  onNavigateToRoomMap,
  zones = NO_ZONES,
  lightNames = NO_NAMES,
  onIdentify,
}: Props) {
  const { t } = useTranslation();
  const busyNoteId = useId();

  // Stable refs so the effects below do not cycle on new array identities.
  const placementsRef = useRef<HueChannelPlacement[]>(placements ?? []);
  placementsRef.current = placements ?? [];

  const zonesRef = useRef<readonly HueZone[]>(zones);
  zonesRef.current = zones;

  const syncedPositionsRef = useRef(syncedPositions);
  syncedPositionsRef.current = syncedPositions;
  const onSyncedPositionsChangeRef = useRef(onSyncedPositionsChange);
  onSyncedPositionsChangeRef.current = onSyncedPositionsChange;

  const [isSaving, setIsSaving] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<"save" | "pull" | null>(null);
  const [identifyingIndex, setIdentifyingIndex] = useState<number | null>(null);
  const [actionResult, setActionResult] = useState<BridgeActionResult | null>(null);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>(() =>
    channels.map((ch) => resolveChannelPlacement(ch, placementsRef.current, zonesRef.current)),
  );

  // Re-initialize when channels change (area switch). placementsRef read via ref to avoid cycle.
  useEffect(() => {
    setChannelPlacements(
      channels.map((ch) => resolveChannelPlacement(ch, placementsRef.current, zonesRef.current)),
    );
  }, [channels]);

  // The room map seeds itself now, but this stays: whichever surface the user
  // opens first has to be the one that reconciles. The parent's write refreshes
  // `placements`, so the second pass finds nothing missing.
  useEffect(() => {
    if (!onPositionChange || channels.length === 0) return;
    const { resolved, needsWrite } = seedChannelPlacements(
      channels,
      placementsRef.current,
      zonesRef.current,
    );
    if (needsWrite) onPositionChange(resolved);
  }, [channels, onPositionChange]);

  const isStale = channelsStatus === HUE_AREA_CHANNELS_STATUS.UNREACHABLE;

  // The bridge's own arrangement, when the list we hold is one. It is what the
  // verdict compares against, and it is recorded so the verdict survives a
  // later read that cannot be trusted (one made while lighting is on).
  const bridgeRead = useMemo(
    () => (channelsFromBridge && !isStale ? bridgeSnapshot(channels) : undefined),
    [channels, channelsFromBridge, isStale],
  );
  useEffect(() => {
    if (!bridgeRead || sameSnapshot(bridgeRead, syncedPositionsRef.current)) return;
    onSyncedPositionsChangeRef.current?.(bridgeRead);
  }, [bridgeRead]);

  const bridgeArrangement = bridgeRead ?? syncedPositions;

  useEffect(
    () => () => {
      if (resultTimerRef.current !== null) clearTimeout(resultTimerRef.current);
    },
    [],
  );

  const showResult = useCallback((result: BridgeActionResult | null, dismissAfterMs?: number) => {
    if (resultTimerRef.current !== null) {
      clearTimeout(resultTimerRef.current);
      resultTimerRef.current = null;
    }
    setActionResult(result);
    if (result !== null && dismissAfterMs !== undefined) {
      resultTimerRef.current = setTimeout(() => {
        setActionResult(null);
        resultTimerRef.current = null;
      }, dismissAfterMs);
    }
  }, []);

  const runSave = useCallback(async () => {
    if (!bridgeIp || username === undefined || !areaId) return;
    setIsSaving(true);
    showResult(null);

    try {
      const response = await updateHueChannelPositions({
        channels: channelPlacements,
        bridgeIp,
        username,
        areaId,
      });
      if (response.code === HUE_RUNTIME_STATUS.CHANNEL_POSITIONS_UPDATED) {
        // `details` is set only when the bridge skipped something.
        const skippedIds = parseSkippedChannelIds(response.details);
        onSyncedPositionsChange?.(
          snapshotAfterPush(channelPlacements, bridgeArrangement, skippedIds),
        );
        if (response.details) {
          showResult({ kind: "savedPartial", skippedIds }, DETAIL_DISMISS_MS);
        } else {
          showResult({ kind: "saved" }, SAVED_DISMISS_MS);
        }
        // The bridge re-derives what it stored; read back what it actually holds.
        void onRefreshChannels?.();
      } else {
        showResult({ kind: "saveFailed", code: response.code });
      }
    } catch (err) {
      console.error("[LumaSync] Hue channel-position write-back failed:", err);
      showResult({ kind: "saveFailed", code: CHANNEL_WRITEBACK_STATUS.NETWORK_ERROR });
    } finally {
      setIsSaving(false);
    }
  }, [
    bridgeIp,
    username,
    areaId,
    channelPlacements,
    bridgeArrangement,
    onSyncedPositionsChange,
    onRefreshChannels,
    showResult,
  ]);

  /** Take the bridge's arrangement. Destructive — it replaces local placement —
   *  so it asks first. Gated on the runtime being off for the same reason the
   *  push is, and adopts only a fresh read that is the bridge's own: while a
   *  stream runs, the channel list carries our own placements. */
  const runPull = useCallback(async () => {
    setIsPulling(true);
    showResult(null);
    try {
      const read: HueAreaChannelsRead | null = onRefreshChannels
        ? await onRefreshChannels()
        : { status: channelsStatus ?? "", channels, fromBridge: channelsFromBridge };
      if (!read || !read.fromBridge || read.channels.length === 0) {
        console.warn(
          `[LumaSync] Hue pull skipped: no bridge-owned channel list (status ${read?.status ?? "none"})`,
        );
        showResult({ kind: "pullFailed" });
        return;
      }
      const zonesNow = zonesRef.current;
      const adopted = read.channels.map((ch) =>
        adoptBridgePlacement(
          resolveChannelPlacement(ch, placementsRef.current, zonesNow),
          ch,
          zonesNow,
        ),
      );
      // What the room map will resolve these to, which is where a zone that
      // cannot reach the bridge's position shows.
      const resolved = read.channels.map((ch) => resolveChannelPlacement(ch, adopted, zonesNow));
      const snapshot = bridgeSnapshot(read.channels);
      setChannelPlacements(resolved);
      onPositionChange?.(adopted);
      onSyncedPositionsChange?.(snapshot);
      const clampedIds = differingChannelIds(resolved, snapshot);
      showResult(
        { kind: "pulled", clampedIds },
        clampedIds.length > 0 ? DETAIL_DISMISS_MS : SAVED_DISMISS_MS,
      );
    } catch (err) {
      console.error("[LumaSync] Hue channel-position pull failed:", err);
      showResult({ kind: "pullFailed" });
    } finally {
      setIsPulling(false);
    }
  }, [
    channels,
    channelsStatus,
    channelsFromBridge,
    onPositionChange,
    onSyncedPositionsChange,
    onRefreshChannels,
    showResult,
  ]);

  const runIdentify = useCallback(
    async (channelIndex: number, lightIds: string[]) => {
      if (!onIdentify) return;
      setIdentifyingIndex(channelIndex);
      showResult(null);
      try {
        const status = await onIdentify(lightIds);
        if (status.code !== HUE_IDENTIFY_STATUS.OK) {
          console.warn(`[LumaSync] Hue identify: ${status.code}${status.details ? ` — ${status.details}` : ""}`);
          showResult({ kind: "identifyFailed", code: status.code }, DETAIL_DISMISS_MS);
        }
      } finally {
        setIdentifyingIndex(null);
      }
    },
    [onIdentify, showResult],
  );

  const confirmPending = useCallback(() => {
    const action = pendingConfirm;
    setPendingConfirm(null);
    if (action === "save") void runSave();
    else if (action === "pull") void runPull();
  }, [pendingConfirm, runSave, runPull]);

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

  // A re-read this panel asked for keeps the rows, the dialog and the result on
  // screen rather than blinking to "loading".
  if (isLoading && !isPulling && !isSaving && actionResult === null) {
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

  const syncState = deriveHueSyncState(channelPlacements, bridgeArrangement);
  // Gated on the runtime, not just on streaming: a solid-colour session also
  // holds a channel list with our placements applied.
  const bridgeBusy = isStreaming || isStale;
  const hasSaveAction = Boolean(bridgeIp && areaId) && username !== undefined;
  // Same pairing prerequisites as the save, and its streaming note says why
  // the button is off.
  const identifyEnabled = hasSaveAction && onIdentify !== undefined;
  const actionBusy = isSaving || isPulling;
  // Said on the page, not in a tooltip: a disabled button shows no title.
  const busyNote = isStreaming && !isStale ? t("hue:channelMap.streamingNote") : null;

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
          {onNavigateToRoomMap && (
            <button type="button" className="lm-chmap-hint-cta" onClick={onNavigateToRoomMap}>
              {t("hue:channelMap.openRoomMap")}
            </button>
          )}
        </p>

        {isStale && (
          <div className="lm-chmap-state is-unreachable" role="status">
            <span className="lm-chmap-state-b">{t("hue:channelMap.state.staleBody")}</span>
          </div>
        )}

        {persistError && <Callout tone="error">{t("hue:channelMap.saveError")}</Callout>}
      </div>

      <div className="lm-chmap-rows">
        {channels.map((ch) => {
          const placement =
            findHueChannel(channelPlacements, ch.index) ??
            resolveChannelPlacement(ch, placementsRef.current, zonesRef.current);
          const zone = zones.find((z) => z.id === placement.zoneId);
          // The bridge's own id, rendered raw: `#0` is a legitimate channel.
          const idLabel = `#${ch.channelId}`;
          const named = namedLights(ch.lightIds, lightNames);
          const countLabel =
            ch.lightCount === 1
              ? t("hue:channelMap.oneLight")
              : t("hue:channelMap.lights", { count: ch.lightCount });
          const shownNames = named?.slice(0, NAMES_SHOWN) ?? [];
          const unshown = ch.lightIds.length - shownNames.length;
          const lightsLabel =
            named === null
              ? countLabel
              : unshown > 0
                ? t("hue:channelMap.moreLights", { names: shownNames.join(", "), count: unshown })
                : shownNames.join(", ");

          return (
            <div
              key={ch.index}
              className="lm-chmap-row"
              role="group"
              aria-label={t("hue:channelMap.channelRowAriaLabel", { index: idLabel })}
            >
              <div className="lm-chmap-row-id">
                <span className="lm-chmap-row-dot" aria-hidden />
                <span className="lm-chmap-row-num">{idLabel}</span>
                <span className="lm-chmap-row-lights" title={named?.join(", ")}>
                  {lightsLabel}
                </span>
              </div>

              <div className="lm-chmap-row-trail">
                {identifyEnabled && ch.lightIds.length > 0 ? (
                  <Button
                    size="md"
                    disabled={isStreaming || identifyingIndex !== null}
                    busy={identifyingIndex === ch.index}
                    aria-label={t("hue:channelMap.identifyAriaLabel", { index: idLabel })}
                    aria-describedby={busyNote ? busyNoteId : undefined}
                    onClick={() => { void runIdentify(ch.index, ch.lightIds); }}
                    data-testid={`hue-chmap-identify-${ch.channelId}`}
                  >
                    {identifyingIndex === ch.index
                      ? t("hue:channelMap.identifying")
                      : t("hue:channelMap.identify")}
                  </Button>
                ) : null}
                {zone ? (
                  <span className="lm-chmap-row-zone">{zone.name}</span>
                ) : (
                  <span className="lm-chmap-row-zone is-none">
                    {t("hue:channelMap.noZone")}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasSaveAction && (
        <div className="lm-chmap-footer">
          <div className="lm-chmap-sync" role="status">
            <span className={`lm-chmap-sync-dot is-${syncState}`} aria-hidden />
            <span className="lm-chmap-sync-tx">
              {syncState === HUE_SYNC_STATE.IN_SYNC
                ? t("hue:channelMap.sync.inSync")
                : syncState === HUE_SYNC_STATE.LOCAL_AHEAD
                  ? t("hue:channelMap.sync.localAhead")
                  : t("hue:channelMap.sync.unknown")}
            </span>
          </div>
          <div className="lm-chmap-footer-row">
            <span className="lm-chmap-beta">{t("hue:channelMap.beta")}</span>
            <div className="lm-chmap-footer-spacer" />
            <Button
              disabled={bridgeBusy || actionBusy || channels.length === 0}
              busy={isPulling}
              aria-describedby={busyNote ? busyNoteId : undefined}
              onClick={() => setPendingConfirm("pull")}
            >
              {t("hue:channelMap.pullFromBridge")}
            </Button>
            <Button
              variant="primary"
              disabled={bridgeBusy || actionBusy}
              busy={isSaving}
              title={isStale ? t(EMPTY_STATE_KEYS.unreachable.heading) : undefined}
              aria-describedby={busyNote ? busyNoteId : undefined}
              onClick={() => setPendingConfirm("save")}
            >
              {isSaving ? t("hue:channelMap.saving") : t("hue:channelMap.saveToBridge")}
            </Button>
          </div>
          {busyNote ? (
            <p className="lm-chmap-busy-note" id={busyNoteId} data-testid="hue-chmap-streaming-note">
              {busyNote}
            </p>
          ) : null}
          {actionResult !== null && renderResult(actionResult)}
        </div>
      )}

      {pendingConfirm !== null && (
        <ConfirmDialog
          title={
            pendingConfirm === "save"
              ? t("hue:channelMap.saveConfirmTitle")
              : t("hue:channelMap.pullConfirmTitle")
          }
          body={
            pendingConfirm === "save"
              ? t("hue:channelMap.saveConfirm", { ip: bridgeIp })
              : t("hue:channelMap.pullConfirm")
          }
          confirmLabel={
            pendingConfirm === "save"
              ? t("hue:channelMap.saveToBridge")
              : t("hue:channelMap.pullFromBridge")
          }
          cancelLabel={t("hue:page.cancel")}
          onConfirm={confirmPending}
          onCancel={() => setPendingConfirm(null)}
          testId="hue-channel-map-confirm"
        />
      )}
    </section>
  );

  function renderResult(result: BridgeActionResult) {
    switch (result.kind) {
      case "identifyFailed": {
        if (result.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED) {
          return (
            <Callout
              tone="error"
              action={onRepair ? { label: t("hue:runtime.actions.repair"), onClick: onRepair } : undefined}
            >
              {t("hue:credential.repairHint")}
            </Callout>
          );
        }
        const key =
          result.code === HUE_IDENTIFY_STATUS.BLOCKED_STREAMING
            ? "hue:channelMap.identifyBlocked"
            : result.code === HUE_IDENTIFY_STATUS.PARTIAL
              ? "hue:channelMap.identifyPartial"
              : "hue:channelMap.identifyFailed";
        return <Callout tone={result.code === HUE_IDENTIFY_STATUS.PARTIAL ? "warning" : "error"}>{t(key)}</Callout>;
      }
      case "saved":
        return <Callout tone="ok">{t("hue:channelMap.savedToBridge")}</Callout>;
      case "savedPartial":
        return (
          <Callout tone="warning">
            {result.skippedIds.length > 0
              ? t("hue:channelMap.savedPartial", { channels: channelList(result.skippedIds) })
              : t("hue:channelMap.savedPartialUnnamed")}
          </Callout>
        );
      case "pulled":
        return result.clampedIds.length > 0 ? (
          <Callout tone="warning">
            {t("hue:channelMap.pulledClamped", { channels: channelList(result.clampedIds) })}
          </Callout>
        ) : (
          <Callout tone="ok">{t("hue:channelMap.pulled")}</Callout>
        );
      case "pullFailed":
        return <Callout tone="error">{t("hue:channelMap.pullFailed")}</Callout>;
      case "saveFailed": {
        const needsRepair = result.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED;
        const action =
          needsRepair && onRepair
            ? { label: t("hue:runtime.actions.repair"), onClick: onRepair }
            : RETRYABLE_WRITEBACK_CODES.has(result.code)
              ? { label: t("hue:channelMap.saveToBridgeErrorRetry"), onClick: () => { void runSave(); } }
              : undefined;
        return (
          <Callout tone="error" action={action}>
            {t("hue:channelMap.saveToBridgeError", {
              reason: t(`hue:runtime.writeback.codes.${result.code}`, {
                defaultValue: result.code,
              }),
            })}
          </Callout>
        );
      }
    }
  }
}
