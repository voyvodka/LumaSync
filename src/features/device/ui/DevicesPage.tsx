import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  resolveHueOffBehavior,
  type HueChannelPlacementOverride,
  type HueOffBehavior,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, hueChannelsForArea, mergeHueChannels } from "@/shared/contracts/roomMap";
import type { HueChannelPlacement, HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";
import { shellStore } from "@/features/persistence/shellStore";
import { useHueOnboarding } from "@/features/hue/useHueOnboarding";
import { HuePage } from "@/features/hue/ui/HuePage";
import { useTransientFlag } from "@/shared/lib/useTransientFlag";
import { useSessionState } from "@/shared/lib/useSessionState";
import { Rail } from "@/shared/ui/Rail/Rail";
import { primaryStrip, stripsOf } from "@/features/strips/model/stripSelectors";
import type { LedStrip } from "@/shared/contracts/strips";
import type { DeviceCategory, DeviceCategoryRequest } from "../model/deviceCategories";
import {
  categoryOfEntry,
  deviceRailEntries,
  entryForCategory,
  type DeviceRailEntry,
} from "../model/deviceRail";
import { railItem, stripName } from "./deviceRailRows";
import { AddStripPage, FoundPortPage } from "./AddStripPage";
import type { AddedOutput } from "./AddStripRows";
import { StripPage } from "./StripPage";
import { WledStripPage } from "./WledStripPage";
import { useDeviceConnection } from "../useDeviceConnection";
import { useActiveWledSink } from "../useWledSink";
import styles from "./DevicesPage.module.css";

/** How long an added strip is waited for before the page stops expecting it. */
const ARRIVAL_WAIT_MS = 5000;

/** The strip LED Setup lays out, as Devices knows it. */
export interface LedSetupTarget {
  /** `null` with no strip saved yet: the first layout makes one. */
  strip: LedStrip | null;
  /** Its name on the rail, for the way back. */
  name: string;
  /** The strip a layout with no strip named applies to — the one the lighting reads. */
  primary: boolean;
  /** Its serial port, when it has one. */
  port: string | null;
}

export interface DevicesPageProps {
  /**
   * Deep-link the user from the "Paired strips" sub-card
   * back to the Room Map editor where the strip's placement and LED
   * count live. Inert when omitted.
   */
  onNavigateToRoomMap?: () => void;
  /** Opens LED Setup on strip `stripId`, where its layout is drawn. */
  onNavigateToLedSetup?: (stripId: string) => void;
  /** The captured display, named when there is more than one; each strip's Layout row shows it. */
  capturedDisplay?: string | null;
  /** LED Setup, open over the page on a strip; `null` while it is not. */
  ledSetup?: { stripId: string | null } | null;
  /** Draws LED Setup for the strip it is open on. Handed in: Devices knows the strip, not the editor. */
  renderLedSetup?: (target: LedSetupTarget) => ReactNode;
  /** The strip LED Setup was open on is no longer saved: it closes, its draft has nowhere to go. */
  onLedSetupStripGone?: () => void;
  /** Forwarded to the Hue page; see `HuePageProps.onStopHue`. */
  onStopHueOutput: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  /** Opens a category from outside, e.g. a notice's "Devices" action for Hue. */
  categoryRequest?: DeviceCategoryRequest | null;
  /** The category on view, and `null` on unmount; the shell's notices defer to it. */
  onVisibleCategoryChange?: (category: DeviceCategory | null) => void;
  /** A bridge is paired and Hue is streaming: the bridge row's dot. */
  hueActive?: boolean;
}

export function DevicesPage({
  onNavigateToRoomMap,
  onNavigateToLedSetup,
  ledSetup = null,
  renderLedSetup,
  onLedSetupStripGone,
  capturedDisplay = null,
  onStopHueOutput,
  categoryRequest = null,
  onVisibleCategoryChange,
  hueActive = false,
}: DevicesPageProps) {
  const { t } = useTranslation();

  // Mounted once and handed to the children whole: `useHueOnboarding` composes
  // the polling loops, so a second mount doubles the traffic to the bridge.
  const hue = useHueOnboarding();
  const device = useDeviceConnection();

  const { selectedAreaId } = hue;
  // The controller scans what is plugged in as it starts, and the port watcher keeps the list in step.
  const { connectedPort } = device;
  const wled = useActiveWledSink();
  const { activeWledIp } = wled;

  // -------------------------------------------------------------------------
  // Channel placement persistence (D-05a)
  // -------------------------------------------------------------------------

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>([]);
  const [syncedPositions, setSyncedPositions] = useState<HueChannelPlacementOverride[] | undefined>();
  const [hueZones, setHueZones] = useState<HueZone[]>([]);
  const [hueOffBehavior, setHueOffBehavior] = useState<HueOffBehavior | null>(null);
  const hueChannelPersistError = useTransientFlag();

  // Load placements from shellStore on mount and when selectedAreaId changes
  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        const stored = state.roomMap?.hueChannels ?? [];
        setChannelPlacements(selectedAreaId ? hueChannelsForArea(stored, selectedAreaId) : stored);
        setSyncedPositions(
          selectedAreaId ? state.hueBridgeSyncedPositions?.[selectedAreaId] : undefined,
        );
        setHueZones(state.roomMap?.zones ?? []);
        setHueOffBehavior(resolveHueOffBehavior(state.hueOffBehavior));
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] Devices: loading room-map placements failed:", error);
      });
    return () => { cancelled = true; };
  }, [selectedAreaId]);

  // -------------------------------------------------------------------------
  // The rail: one row per device
  // -------------------------------------------------------------------------
  // Remembered for the session, so a return opens on the rows it left instead of filling them in.
  const [strips, setStrips] = useSessionState<LedStrip[] | null>("devices.strips", null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      shellStore
        .load()
        .then((state) => {
          if (!cancelled) setStrips(stripsOf(state));
        })
        .catch((error: unknown) => {
          console.error("[LumaSync] Devices: reading the strips failed:", error);
        });
    };
    read();
    // A connect, a WLED bind or a forget rewrites the strips from elsewhere.
    const stop = shellStore.onSaved((saved) => {
      if ("ledStrips" in saved) read();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [setStrips]);

  // A bridge is the Hue row once it is paired; before that it is something found.
  const pairedBridgeId = hue.credentials !== null ? hue.selectedBridgeId : null;
  const entries: DeviceRailEntry[] | null =
    strips === null
      ? null
      : deviceRailEntries({
          strips,
          ports: device.ports,
          connectedPort,
          activeWledIp,
          hue: {
            bridgeName: pairedBridgeId !== null ? (hue.selectedBridge?.name ?? null) : null,
            pairedBridgeId,
            streaming: hueActive,
            found: hue.bridges,
          },
        });

  // A deep link wins once; after that the row the user last chose stays, until a restart.
  const [storedEntry, setStoredEntry] = useSessionState<string | null>("devices.entry", null);
  const [handledRequest, setHandledRequest] = useSessionState<number | null>("devices.handledRequest", null);
  if (entries !== null && categoryRequest !== null && categoryRequest.nonce !== handledRequest) {
    setHandledRequest(categoryRequest.nonce);
    setStoredEntry(entryForCategory(entries, categoryRequest.category));
  }
  // A row that went away (a port unplugged, a strip forgotten) falls back to the first strip; a
  // found bridge that was just paired is the Hue row now.
  const activeEntry: DeviceRailEntry | null =
    entries === null
      ? null
      : (entries.find((entry) => entry.id === storedEntry) ??
        (pairedBridgeId !== null && storedEntry === `bridge:${pairedBridgeId}`
          ? entries.find((entry) => entry.kind === "hue")
          : undefined) ??
        entries.find((entry) => entry.id === entryForCategory(entries, "strips")) ??
        null);
  const activeCategory: DeviceCategory = activeEntry ? categoryOfEntry(activeEntry) : "strips";
  const activeId = activeEntry?.id ?? null;
  // What was just added opens as the strip it became, and asks whether it lit. The strip appears
  // once the save lands, a render or two after the connect answers. A save that never lands must not
  // leave it waiting: a later connect of the same port would jump the page and flash unasked.
  const [arriving, setArriving] = useState<AddedOutput | null>(null);
  const [flashFor, setFlashFor] = useState<string | null>(null);
  const clearFlash = useCallback(() => setFlashFor(null), []);
  useEffect(() => {
    if (arriving === null) return;
    const timer = setTimeout(() => setArriving(null), ARRIVAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [arriving]);
  const selectEntry = (id: string) => {
    setArriving(null);
    setStoredEntry(id);
    const entry = entries?.find((candidate) => candidate.id === id);
    if (entry?.kind === "port") device.selectPort(entry.port.portName);
  };

  // Layout effects, so a notice this page already shows is gone before paint.
  useLayoutEffect(() => {
    onVisibleCategoryChange?.(activeCategory);
  }, [activeCategory, onVisibleCategoryChange]);
  useLayoutEffect(() => () => onVisibleCategoryChange?.(null), [onVisibleCategoryChange]);

  // One scroller serves every row's page — they only toggle `hidden` — so the
  // offset carries over and a taller page opens past its own heading.
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the trigger that resets the shared scroller
  useEffect(() => {
    const main = mainScrollRef.current;
    if (main) main.scrollTop = 0;
  }, [activeId]);
  const handlePositionChange = useCallback(async (updated: HueChannelPlacement[]) => {
    // Stamped here rather than in the panel: the panel is handed one area's
    // channels and has no reason to know which, but the merge cannot tell two
    // areas' channel 0 apart without it.
    const scoped = selectedAreaId
      ? updated.map((p) => ({ ...p, entertainmentAreaId: selectedAreaId }))
      : updated;
    setChannelPlacements(scoped);
    try {
      const current = await shellStore.load();
      const currentRoomMap = current.roomMap;
      const updatedRoomMap: RoomMapConfig = {
        ...(currentRoomMap ?? DEFAULT_ROOM_MAP),
        hueChannels: mergeHueChannels(currentRoomMap?.hueChannels ?? [], scoped),
      };
      await shellStore.save({
        roomMap: updatedRoomMap,
        roomMapVersion: (current.roomMapVersion ?? 0) + 1,
      });
      hueChannelPersistError.clear();
    } catch (e) {
      console.error("[LumaSync] handlePositionChange failed", e);
      hueChannelPersistError.raise();
    }
  }, [hueChannelPersistError, selectedAreaId]);

  /** Rust reads it from the saved state when an Off runs; saving is all it takes. */
  const handleHueOffBehaviorChange = useCallback((next: HueOffBehavior) => {
    setHueOffBehavior(next);
    void shellStore.save({ hueOffBehavior: next }).catch((error: unknown) => {
      console.error("[LumaSync] saving hueOffBehavior failed:", error);
    });
  }, []);

  /** Recorded per area: two areas' arrangements are pushed independently, and a
   *  single snapshot would report one of them wrong. */
  const handleSyncedPositionsChange = useCallback(
    async (snapshot: HueChannelPlacementOverride[]) => {
      if (!selectedAreaId) return;
      const areaId = selectedAreaId;
      setSyncedPositions(snapshot);
      try {
        const current = await shellStore.load();
        await shellStore.save({
          hueBridgeSyncedPositions: {
            ...(current.hueBridgeSyncedPositions ?? {}),
            [areaId]: snapshot,
          },
        });
      } catch (e) {
        console.error("[LumaSync] handleSyncedPositionsChange failed", e);
      }
    },
    [selectedAreaId],
  );

  if (arriving !== null && entries !== null) {
    const landed = entries.find(
      (entry) =>
        entry.kind === "strip" &&
        (arriving.kind === "serial"
          ? entry.strip.transport?.kind === "serial" && entry.strip.transport.portName === arriving.portName
          : entry.strip.transport?.kind === "wled" && entry.strip.transport.sink.ip === arriving.ip),
    );
    if (landed?.kind === "strip") {
      setArriving(null);
      setStoredEntry(landed.id);
      setFlashFor(landed.strip.id);
    }
  }

  // Adding moves the strip that is driven now: one strip at a time until several can run.
  const driven = strips?.find((strip) => strip.enabled && strip.transport !== null) ?? null;
  const drivenEntry = entries?.find((entry) => entry.kind === "strip" && entry.strip === driven);
  const replaces = drivenEntry?.kind === "strip" ? stripName(drivenEntry, t) : null;
  const foundPorts = entries?.flatMap((entry) => (entry.kind === "port" ? [entry.port] : [])) ?? [];
  const otherPorts = device.ports.filter((port) => !port.isSupported);
  const showsHue = activeEntry?.kind === "hue" || activeEntry?.kind === "bridge";

  // With no strip named, the strip a layout with no strip named applies to; none before the first.
  const editedStrip =
    ledSetup === null || strips === null
      ? null
      : ledSetup.stripId === null
        ? (primaryStrip(strips) ?? null)
        : (strips.find((strip) => strip.id === ledSetup.stripId) ?? null);
  // Forgotten while open: not the "no strip yet" of a first layout, which would lay out another one.
  const editedGone = ledSetup !== null && ledSetup.stripId !== null && strips !== null && editedStrip === null;
  useEffect(() => {
    if (editedGone) onLedSetupStripGone?.();
  }, [editedGone, onLedSetupStripGone]);
  const editedEntry = entries?.find((entry) => entry.kind === "strip" && entry.strip.id === editedStrip?.id);
  // Back from LED Setup lands on the strip it laid out.
  const editedEntryId = editedEntry?.id ?? null;
  const [returnedTo, setReturnedTo] = useState<string | null>(null);
  if (editedEntryId !== null && editedEntryId !== returnedTo) {
    setReturnedTo(editedEntryId);
    setStoredEntry(editedEntryId);
  } else if (ledSetup === null && returnedTo !== null) {
    setReturnedTo(null);
  }
  const editor =
    ledSetup !== null && strips !== null && renderLedSetup && !editedGone
      ? renderLedSetup({
          strip: editedStrip,
          name: editedEntry?.kind === "strip" ? stripName(editedEntry, t) : t("settings:nav.sections.devices"),
          primary: editedStrip === null || editedStrip.id === primaryStrip(strips)?.id,
          port: editedStrip?.transport?.kind === "serial" ? editedStrip.transport.portName : null,
        })
      : null;

  return (
    <>
    {editor !== null ? <div className={styles.editor}>{editor}</div> : null}
    <div className={styles.page} hidden={editor !== null}>
      {entries === null || activeId === null ? (
        // The strips are read from the saved state; the rail keeps its place empty until they are known.
        <nav className={styles.railPlaceholder} aria-label={t("device:page.rail.label")} />
      ) : (
        <Rail
          label={t("device:page.rail.label")}
          items={entries.map((entry) => railItem(entry, t))}
          active={activeId}
          onSelect={selectEntry}
        />
      )}

      {/* Every page stays mounted and hides via `hidden`, so switching the
          rail never remounts a page or replays its effects. */}
      <div className={styles.main} ref={mainScrollRef}>
        {entries?.map((entry) => {
          const isActive = entry.id === activeId;
          if (entry.kind === "strip") {
            const transport = entry.strip.transport;
            const name = stripName(entry, t);
            if (transport?.kind === "serial") {
              return (
                <StripPage
                  key={entry.id}
                  isActive={isActive}
                  strip={{ ...entry.strip, transport }}
                  name={name}
                  device={device}
                  onNavigateToLedSetup={onNavigateToLedSetup && (() => onNavigateToLedSetup(entry.strip.id))}
                  capturedDisplay={capturedDisplay}
                  onNavigateToRoomMap={onNavigateToRoomMap}
                  autoFlash={flashFor === entry.strip.id}
                  onAutoFlashDone={clearFlash}
                />
              );
            }
            if (transport?.kind === "wled") {
              return (
                <WledStripPage
                  key={entry.id}
                  isActive={isActive}
                  strip={{ ...entry.strip, transport }}
                  name={name}
                  wled={wled}
                  onNavigateToLedSetup={onNavigateToLedSetup && (() => onNavigateToLedSetup(entry.strip.id))}
                  capturedDisplay={capturedDisplay}
                  onNavigateToRoomMap={onNavigateToRoomMap}
                  autoFlash={flashFor === entry.strip.id}
                  onAutoFlashDone={clearFlash}
                />
              );
            }
            // A strip whose controller was forgotten keeps its layout; giving it one is adding.
            return (
              <AddStripPage
                key={entry.id}
                isActive={isActive}
                title={name}
                ports={foundPorts}
                otherPorts={otherPorts}
                device={device}
                onWledBound={wled.markConnected}
                boundWledIp={activeWledIp}
                replaces={null}
                onAdded={setArriving}
              />
            );
          }
          if (entry.kind === "port") {
            return (
              <FoundPortPage
                key={entry.id}
                isActive={isActive}
                port={entry.port}
                device={device}
                replaces={replaces}
                onAdded={setArriving}
              />
            );
          }
          if (entry.kind === "add") {
            return (
              <AddStripPage
                key={entry.id}
                isActive={isActive}
                title={t("device:strip.add.title")}
                ports={foundPorts}
                otherPorts={otherPorts}
                device={device}
                onWledBound={wled.markConnected}
                boundWledIp={activeWledIp}
                replaces={replaces}
                onAdded={setArriving}
              />
            );
          }
          return null;
        })}

        <HuePage
          isActive={showsHue}
          hue={hue}
          foundBridge={activeEntry?.kind === "bridge" ? activeEntry.bridge : null}
          channelPlacements={channelPlacements}
          onPositionChange={handlePositionChange}
          syncedPositions={syncedPositions}
          onSyncedPositionsChange={handleSyncedPositionsChange}
          onNavigateToRoomMap={onNavigateToRoomMap}
          persistError={hueChannelPersistError.active}
          zones={hueZones}
          onStopHue={onStopHueOutput}
          offBehavior={hueOffBehavior}
          onOffBehaviorChange={handleHueOffBehaviorChange}
        />
      </div>
    </div>
    </>
  );
}
