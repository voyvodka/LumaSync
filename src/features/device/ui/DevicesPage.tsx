import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  resolveHueOffBehavior,
  type HueChannelPlacementOverride,
  type HueOffBehavior,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, hueChannelsForArea, mergeHueChannels } from "@/shared/contracts/roomMap";
import type {
  HueChannelPlacement,
  HueZone,
  RoomMapConfig,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { shellStore } from "@/features/persistence/shellStore";
import { useHueOnboarding } from "@/features/hue/useHueOnboarding";
import { HuePage } from "@/features/hue/ui/HuePage";
import { UsbStripsCategory } from "@/features/settings/sections/device/UsbStripsCategory";
import { WledCategory } from "@/features/settings/sections/device/WledCategory";
import { useTransientFlag } from "@/features/settings/sections/device/useTransientFlag";
import { useSessionState } from "@/shared/lib/useSessionState";
import { Rail } from "@/shared/ui/Rail/Rail";
import { stripsOf } from "@/features/strips/model/stripSelectors";
import type { LedStrip } from "@/shared/contracts/strips";
import type { DeviceCategory, DeviceCategoryRequest } from "../model/deviceCategories";
import {
  categoryOfEntry,
  deviceRailEntries,
  entryForCategory,
  type DeviceRailEntry,
} from "../model/deviceRail";
import { railItem, stripName } from "./deviceRailRows";
import { StripPage } from "./StripPage";
import { useDeviceConnection } from "../useDeviceConnection";
import { useActiveWledSink } from "../useWledSink";
import styles from "./DevicesPage.module.css";

export interface DevicesPageProps {
  /**
   * Deep-link the user from the "Paired strips" sub-card
   * back to the Room Map editor where the strip's placement and LED
   * count live. Inert when omitted.
   */
  onNavigateToRoomMap?: () => void;
  /** Opens LED Setup, where a strip's layout is drawn. */
  onNavigateToLedSetup?: () => void;
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
  const { connectedPort } = device;
  const { activeWledIp } = useActiveWledSink();

  // -------------------------------------------------------------------------
  // Channel placement persistence (D-05a)
  // -------------------------------------------------------------------------

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>([]);
  const [syncedPositions, setSyncedPositions] = useState<HueChannelPlacementOverride[] | undefined>();
  const [hueZones, setHueZones] = useState<HueZone[]>([]);
  const [pairedStrips, setPairedStrips] = useState<UsbStripPlacement[]>([]);
  const [hueOffBehavior, setHueOffBehavior] = useState<HueOffBehavior | null>(null);
  // One flag per save path. A USB write failure must not light the banner
  // inside the Hue channel-map panel, nor re-arm its dismissal timer.
  const usbPersistError = useTransientFlag();
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
        setPairedStrips(state.roomMap?.usbStrips ?? []);
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
  const selectEntry = (id: string) => {
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
  // The room-map editor authors strips on its own surface; re-hydrating here
  // catches those edits without coupling the two stores.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectedPort is the trigger that re-reads strips paired elsewhere
  useEffect(() => {
    if (activeCategory !== "strips") return;
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setPairedStrips(state.roomMap?.usbStrips ?? []);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] Devices: re-reading paired USB strips failed:", error);
      });
    return () => { cancelled = true; };
  }, [activeCategory, connectedPort]);

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

  // Until each row has a page of its own (D2, D3), a row shows the pane it belongs to.
  const kind = activeEntry?.kind ?? null;
  const transport = activeEntry?.kind === "strip" ? (activeEntry.strip.transport?.kind ?? null) : null;
  const showsUsb = kind === "port" || kind === "add" || (kind === "strip" && transport === null);
  const showsHue = kind === "hue" || kind === "bridge";
  const showsWled = kind === "add" || (kind === "strip" && transport === "wled");

  return (
    <div className={styles.page}>
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

      {/* Every pane stays mounted and hides via `hidden`, so switching the
          rail never remounts a pane or replays its effects. */}
      <div className={styles.main} ref={mainScrollRef}>
        <UsbStripsCategory
          isActive={showsUsb}
          device={device}
          pairedStrips={pairedStrips}
          setPairedStrips={setPairedStrips}
          persistError={usbPersistError.active}
          flagPersistError={usbPersistError.raise}
          clearPersistError={usbPersistError.clear}
          onNavigateToRoomMap={onNavigateToRoomMap}
        />

        {entries?.map((entry) =>
          entry.kind === "strip" && entry.strip.transport?.kind === "serial" ? (
            <StripPage
              key={entry.id}
              isActive={entry.id === activeId}
              strip={{ ...entry.strip, transport: entry.strip.transport }}
              name={stripName(entry, t)}
              device={device}
              onNavigateToLedSetup={onNavigateToLedSetup}
              onNavigateToRoomMap={onNavigateToRoomMap}
            />
          ) : null,
        )}

        <WledCategory isActive={showsWled} />

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
  );
}
