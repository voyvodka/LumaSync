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
  toSyncSnapshot,
  type HueSyncState,
} from "@/features/hue/model/hueSyncState";
import type { TranslationKey } from "@/features/i18n/catalogue";
import { parseSkippedChannelIds } from "@/features/hue/model/hueWritebackResult";
import { Menu } from "@/shared/ui/Menu/Menu";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, RowNote, rowStyles, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import styles from "./HuePage.module.css";

/** What taking the bridge's arrangement leaves: each channel placed where the bridge has it, then
 *  held inside its room-map zone. */
function takeBridgeArrangement(
  bridgeChannels: readonly HueAreaChannelInfo[],
  placements: readonly HueChannelPlacement[],
  zones: readonly HueZone[],
): { adopted: HueChannelPlacement[]; resolved: HueChannelPlacement[] } {
  const adopted = bridgeChannels.map((ch) =>
    adoptBridgePlacement(resolveChannelPlacement(ch, [...placements], zones), ch, zones),
  );
  const resolved = bridgeChannels.map((ch) => resolveChannelPlacement(ch, adopted, zones));
  return { adopted, resolved };
}

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

const SYNC_WORD = {
  [HUE_SYNC_STATE.IN_SYNC]: "hue:channelMap.sync.inSyncShort",
  [HUE_SYNC_STATE.LOCAL_AHEAD]: "hue:channelMap.sync.localAheadShort",
  [HUE_SYNC_STATE.UNKNOWN]: "hue:channelMap.sync.unknownShort",
} as const satisfies Record<HueSyncState, TranslationKey>;

function channelList(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(", ");
}

/** The channel's lights by name, or `null` while none of them has one. */
function namedLights(lightIds: readonly string[], names: Readonly<Record<string, string>>): string[] | null {
  const named = lightIds.flatMap((id) => (names[id] ? [names[id]] : []));
  return named.length > 0 ? named : null;
}

/** The area's channels: one row each with its lights and Identify, and the bridge sync behind "…". */
export function HueChannels({
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
      // `resolved` is what the room map will make of it, which is where a zone that cannot reach the
      // bridge's position shows.
      const { adopted, resolved } = takeBridgeArrangement(read.channels, placementsRef.current, zonesRef.current);
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // A re-read this section asked for keeps the rows, the dialog and the result on screen rather
  // than blinking to "loading".
  const loading = isLoading && !isPulling && !isSaving && actionResult === null;
  // Three different facts arrive as the same empty list, and one "no channels" line for all of
  // them is what made a dropped bridge look like an empty area.
  const emptyState: keyof typeof EMPTY_STATE_KEYS | null =
    loading || channels.length > 0 || channelsStatus === undefined || channelsStatus === null
      ? null
      : channelsStatus === HUE_AREA_CHANNELS_STATUS.EMPTY
        ? "empty"
        : channelsStatus === HUE_AREA_CHANNELS_STATUS.UNREACHABLE
          ? "unreachable"
          : "failed";
  if (!loading && channels.length === 0 && emptyState === null) return null;

  const syncState = deriveHueSyncState(channelPlacements, bridgeArrangement);
  // Different only because a zone holds channels inside it: taking the bridge's arrangement again
  // would change nothing, so the note says why instead of offering a send that is not the point.
  const heldByZone =
    syncState === HUE_SYNC_STATE.LOCAL_AHEAD &&
    bridgeRead !== undefined &&
    differingChannelIds(
      channelPlacements,
      toSyncSnapshot(takeBridgeArrangement(channels, channelPlacements, zones).resolved),
    ).length === 0;
  // Gated on the runtime, not just on streaming: a solid-colour session also holds a channel list
  // with our placements applied.
  const bridgeBusy = isStreaming || isStale;
  const hasSaveAction = Boolean(bridgeIp && areaId) && username !== undefined && channels.length > 0;
  // Same pairing prerequisites as the save, and its streaming note says why the button is off.
  const identifyEnabled = hasSaveAction && onIdentify !== undefined;
  const actionBusy = isSaving || isPulling;
  // Said on the page, not in a tooltip: a disabled button shows no title.
  const busyNote = isStreaming && !isStale && hasSaveAction ? t("hue:channelMap.streamingNote") : null;

  const value = loading
    ? t("hue:channelMap.loading")
    : emptyState
      ? t(EMPTY_STATE_KEYS[emptyState].heading)
      : isSaving
        ? t("hue:channelMap.saving")
        : isPulling
          ? t("hue:channelMap.pulling")
          : hasSaveAction
            ? t(SYNC_WORD[syncState])
            : undefined;
  const valueNode = value === undefined ? undefined : <span data-testid="hue-channels-value">{value}</span>;

  return (
    <section className={styles.channels} aria-label={t("hue:channelMap.title")} data-testid="hue-channels">
      <div className={styles.rows}>
        <Reveal open>
          <SettingRow
            label={t("hue:row.channels")}
            hint={t("hue:channelMap.hint")}
            value={valueNode}
            control={
              <>
                {onNavigateToRoomMap ? (
                  <RowButton onClick={onNavigateToRoomMap}>{t("hue:channelMap.openRoomMap")}</RowButton>
                ) : null}
                {hasSaveAction ? (
                  <Menu
                    label={t("hue:channelMap.more")}
                    testId="hue-channels-more"
                    items={[
                      {
                        id: "pull",
                        label: t("hue:channelMap.pullFromBridge"),
                        disabled: bridgeBusy || actionBusy,
                        describedBy: busyNote ? busyNoteId : undefined,
                        onSelect: () => void runPull(),
                        confirm: {
                          title: t("hue:channelMap.pullConfirmTitle"),
                          text: t("hue:channelMap.pullConfirm"),
                          confirmLabel: t("hue:channelMap.pullFromBridge"),
                          cancelLabel: t("hue:page.cancel"),
                          testId: "hue-channel-map-confirm",
                          confirmTestId: "hue-channel-map-confirm-yes",
                        },
                      },
                      {
                        id: "save",
                        label: t("hue:channelMap.saveToBridgeMenu"),
                        disabled: bridgeBusy || actionBusy,
                        describedBy: busyNote ? busyNoteId : undefined,
                        onSelect: () => void runSave(),
                        confirm: {
                          title: t("hue:channelMap.saveConfirmTitle"),
                          text: t("hue:channelMap.saveConfirm", { ip: bridgeIp }),
                          confirmLabel: t("hue:channelMap.saveToBridge"),
                          cancelLabel: t("hue:page.cancel"),
                          testId: "hue-channel-map-confirm",
                          confirmTestId: "hue-channel-map-confirm-yes",
                        },
                      },
                    ]}
                  />
                ) : null}
              </>
            }
          >
            <Reveal open={emptyState !== null}>
              {emptyState ? (
                <RowNote tone="status">{t(EMPTY_STATE_KEYS[emptyState].body)}</RowNote>
              ) : null}
            </Reveal>
            <Reveal open={isStale}>
              <RowNote tone="status">{t("hue:channelMap.state.staleBody")}</RowNote>
            </Reveal>
            <Reveal open={hasSaveAction && syncState === HUE_SYNC_STATE.LOCAL_AHEAD && !actionBusy}>
              <RowNote tone="status" testId="hue-channels-sync-note">
                {t(heldByZone ? "hue:channelMap.sync.heldByZone" : "hue:channelMap.sync.localAhead")}
              </RowNote>
            </Reveal>
            <Reveal open={busyNote !== null}>
              {busyNote ? (
                <p className={rowStyles.note} id={busyNoteId} data-testid="hue-chmap-streaming-note">
                  {busyNote}
                </p>
              ) : null}
            </Reveal>
            <Reveal open={persistError === true}>
              <RowNote tone="error">{t("hue:channelMap.saveError")}</RowNote>
            </Reveal>
            <Reveal open={actionResult !== null}>{actionResult !== null ? renderResult(actionResult) : null}</Reveal>
          </SettingRow>
        </Reveal>

        {channels.map((ch) => {
          const placement =
            findHueChannel(channelPlacements, ch.index) ??
            resolveChannelPlacement(ch, placementsRef.current, zonesRef.current);
          const zone = zones.find((z) => z.id === placement.zoneId);
          // The bridge's own id, rendered raw: `#0` is a legitimate channel.
          const idLabel = `#${ch.channelId}`;
          const named = namedLights(ch.lightIds, lightNames);
          const countLabel =
            ch.lightCount === 1 ? t("hue:channelMap.oneLight") : t("hue:channelMap.lights", { count: ch.lightCount });
          const shownNames = named?.slice(0, NAMES_SHOWN) ?? [];
          const unshown = ch.lightIds.length - shownNames.length;
          const label =
            named === null
              ? idLabel
              : unshown > 0
                ? t("hue:channelMap.moreLights", { names: shownNames.join(", "), count: unshown })
                : shownNames.join(", ");
          const identifying = identifyingIndex === ch.index;

          return (
            <Reveal key={ch.index} open>
              <div
                className={styles.channel}
                role="group"
                aria-label={t("hue:channelMap.channelRowAriaLabel", { index: idLabel })}
                title={named?.join(", ")}
              >
                <SettingRow
                  label={label}
                  value={
                    named === null || zone ? (
                      <>
                        {named === null ? <span>{countLabel}</span> : null}
                        {named === null && zone ? " · " : null}
                        {zone ? <span>{zone.name}</span> : null}
                      </>
                    ) : undefined
                  }
                  control={
                    identifyEnabled && ch.lightIds.length > 0 ? (
                      <RowButton
                        disabled={isStreaming || identifyingIndex !== null}
                        aria-busy={identifying || undefined}
                        aria-label={t("hue:channelMap.identifyAriaLabel", { index: idLabel })}
                        aria-describedby={busyNote ? busyNoteId : undefined}
                        onClick={() => {
                          void runIdentify(ch.index, ch.lightIds);
                        }}
                        data-testid={`hue-chmap-identify-${ch.channelId}`}
                      >
                        <StateSwap
                          fit
                          state={identifying ? "busy" : "idle"}
                          faces={{ idle: t("hue:channelMap.identify"), busy: t("hue:channelMap.identifying") }}
                        />
                      </RowButton>
                    ) : null
                  }
                />
              </div>
            </Reveal>
          );
        })}
      </div>

    </section>
  );

  /** A result as one line under the section, with the one thing to do about it when there is one. */
  function renderResult(result: BridgeActionResult) {
    const line = (tone: "status" | "error", text: string, action?: { label: string; onClick: () => void }) => (
      <RowNote tone={tone}>
        {text}
        {action ? (
          <>
            {" "}
            <button type="button" className={styles.inlineAction} onClick={action.onClick}>
              {action.label}
            </button>
          </>
        ) : null}
      </RowNote>
    );
    const repair = onRepair ? { label: t("hue:runtime.actions.repair"), onClick: onRepair } : undefined;
    switch (result.kind) {
      case "identifyFailed": {
        if (result.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED) {
          return line("error", t("hue:credential.repairHint"), repair);
        }
        const key =
          result.code === HUE_IDENTIFY_STATUS.BLOCKED_STREAMING
            ? "hue:channelMap.identifyBlocked"
            : result.code === HUE_IDENTIFY_STATUS.PARTIAL
              ? "hue:channelMap.identifyPartial"
              : "hue:channelMap.identifyFailed";
        return line(result.code === HUE_IDENTIFY_STATUS.PARTIAL ? "status" : "error", t(key));
      }
      case "saved":
        return line("status", t("hue:channelMap.savedToBridge"));
      case "savedPartial":
        return line(
          "status",
          result.skippedIds.length > 0
            ? t("hue:channelMap.savedPartial", { channels: channelList(result.skippedIds) })
            : t("hue:channelMap.savedPartialUnnamed"),
        );
      case "pulled":
        return line(
          "status",
          result.clampedIds.length > 0
            ? t("hue:channelMap.pulledClamped", { channels: channelList(result.clampedIds) })
            : t("hue:channelMap.pulled"),
        );
      case "pullFailed":
        return line("error", t("hue:channelMap.pullFailed"));
      case "saveFailed": {
        const needsRepair = result.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED;
        const action =
          needsRepair && repair
            ? repair
            : RETRYABLE_WRITEBACK_CODES.has(result.code)
              ? {
                  label: t("hue:channelMap.saveToBridgeErrorRetry"),
                  onClick: () => {
                    void runSave();
                  },
                }
              : undefined;
        return line(
          "error",
          t("hue:channelMap.saveToBridgeError", {
            reason: t(`hue:runtime.writeback.codes.${result.code}`, { defaultValue: result.code }),
          }),
          action,
        );
      }
    }
  }
}
