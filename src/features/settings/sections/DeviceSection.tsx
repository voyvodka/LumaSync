import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LedChipType } from "@/shared/contracts/device";
import type { DisplayInfo } from "@/shared/contracts/display";
import type { HueChannelPlacementOverride } from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, hueChannelsForArea, mergeHueChannels } from "@/shared/contracts/roomMap";
import type {
  HueChannelPlacement,
  HueZone,
  RoomMapConfig,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { shellStore } from "@/features/persistence/shellStore";
import { listDisplays } from "@/features/calibration/calibrationApi";
import { useDeviceConnection } from "@/features/device/useDeviceConnection";
import { useHueOnboarding } from "@/features/hue/useHueOnboarding";
import { DisplaysCategory } from "./device/DisplaysCategory";
import { HueBridgesCategory } from "./device/HueBridgesCategory";
import { ManualEntryCategory } from "./device/ManualEntryCategory";
import { UsbStripsCategory } from "./device/UsbStripsCategory";
import { WledCategory } from "./device/WledCategory";
import { useTransientFlag } from "./device/useTransientFlag";
import {
  IconUsb,
  IconHueBridgeGlyph,
  IconDisplayGlyph,
  IconWledGlyph,
  IconPencil,
} from "@/shared/ui/icons";

type DeviceCategory = "usb" | "hue" | "wled" | "displays" | "manual";

export interface DeviceSectionProps {
  /**
   * Wave 4-E — deep-link the user from the "Paired strips" sub-card
   * back to the Room Map editor where the strip's placement and LED
   * count live. Inert when omitted.
   */
  onNavigateToRoomMap?: () => void;
  /** Forwarded to the chip-type picker; see `UsbStripsCategoryProps`. */
  onChipTypeChange?: (next: LedChipType) => void;
}

interface RailButtonProps {
  icon: React.ReactNode;
  label: string;
  /** Rendered as a badge when non-zero. */
  count: number;
  /** What the badge means, for anyone who cannot see it sit next to the label. */
  countLabel?: string;
  active: boolean;
  onClick: () => void;
}

/**
 * One category in the Devices rail.
 *
 * `aria-current` is the point of extracting this. The rail previously carried
 * its active category in an `is-on` class and nothing else, so five buttons
 * were announced identically and the open one was indistinguishable — while
 * the app's own top-level section tabs have always exposed `aria-selected`.
 * The codebase disagreed with itself.
 *
 * `aria-current="page"` rather than a `role="tablist"`: this is a `<nav>`, and
 * a tablist would promise arrow-key navigation the rail does not implement.
 * Promising the wrong interaction is worse than promising none.
 *
 * The badge is `aria-hidden` with its meaning on the button instead, because a
 * bare "2" read after a label is ambiguous — two of what.
 */
function RailButton({ icon, label, count, countLabel, active, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      className={`lm-device-cat ${active ? "is-on" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="lm-device-cat-ic">{icon}</span>
      <span className="lm-device-cat-tx">{label}</span>
      {count > 0 ? (
        <span className="lm-device-cat-cnt" aria-hidden="true">
          {count}
        </span>
      ) : null}
      {count > 0 && countLabel !== undefined ? <span className="sr-only">{countLabel}</span> : null}
    </button>
  );
}

export function DeviceSection({ onNavigateToRoomMap, onChipTypeChange }: DeviceSectionProps = {}) {
  const { t } = useTranslation();

  // Mounted once and handed to the children whole: `useHueOnboarding` composes
  // the polling loops, so a second mount doubles the traffic to the bridge.
  const hue = useHueOnboarding();
  const device = useDeviceConnection();

  const { selectedBridge, selectedAreaId } = hue;
  const { ports, connectedPort } = device;

  // -------------------------------------------------------------------------
  // Channel placement persistence (D-05a)
  // -------------------------------------------------------------------------

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>([]);
  const [syncedPositions, setSyncedPositions] = useState<HueChannelPlacementOverride[] | undefined>();
  const [hueZones, setHueZones] = useState<HueZone[]>([]);
  const [pairedStrips, setPairedStrips] = useState<UsbStripPlacement[]>([]);
  // One flag per save path. A USB write failure must not light the banner
  // inside the Hue channel-map panel, nor re-arm its dismissal timer.
  const usbPersistError = useTransientFlag();
  const hueChannelPersistError = useTransientFlag();

  // Load placements from shellStore on mount and when selectedAreaId changes
  useEffect(() => {
    let cancelled = false;
    shellStore.load().then((state) => {
      if (cancelled) return;
      const stored = state.roomMap?.hueChannels ?? [];
      setChannelPlacements(selectedAreaId ? hueChannelsForArea(stored, selectedAreaId) : stored);
      setSyncedPositions(
        selectedAreaId ? state.hueBridgeSyncedPositions?.[selectedAreaId] : undefined,
      );
      setHueZones(state.roomMap?.zones ?? []);
      setPairedStrips(state.roomMap?.usbStrips ?? []);
    });
    return () => { cancelled = true; };
  }, [selectedAreaId]);

  // -------------------------------------------------------------------------
  // Phase 7: category rail + displays list
  // -------------------------------------------------------------------------
  const [activeCategory, setActiveCategory] = useState<DeviceCategory>("usb");

  // One scroller serves every category — they only toggle `hidden` — so the
  // offset carries over and a taller category opens past its own heading.
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const main = mainScrollRef.current;
    if (main) main.scrollTop = 0;
  }, [activeCategory]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  // The room-map editor authors strips on its own surface; re-hydrating here
  // catches those edits without coupling the two stores.
  useEffect(() => {
    if (activeCategory !== "usb") return;
    let cancelled = false;
    void shellStore.load().then((state) => {
      if (cancelled) return;
      setPairedStrips(state.roomMap?.usbStrips ?? []);
    });
    return () => { cancelled = true; };
  }, [activeCategory, connectedPort]);

  useEffect(() => {
    let cancelled = false;
    listDisplays()
      .then((result) => {
        if (!cancelled) setDisplays(result);
      })
      .catch((error) => {
        if (cancelled) return;
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[LumaSync] Display list unavailable: ${reason}`);
        setDisplays([]);
      });
    return () => { cancelled = true; };
  }, []);

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

  return (
    <div className="lm-device-page">
      {/* ── Left category rail ───────────────────────────────── */}
      <nav className="lm-device-rail">
        <div className="lm-device-rail-h">{t("device:page.rail.connected")}</div>
        <RailButton
          icon={<IconUsb />}
          label={t("device:page.rail.usbStrips")}
          count={ports.length}
          countLabel={t("device:page.rail.countLabel", { count: ports.length })}
          active={activeCategory === "usb"}
          onClick={() => setActiveCategory("usb")}
        />
        <RailButton
          icon={<IconHueBridgeGlyph />}
          label={t("device:page.rail.hueBridges")}
          count={selectedBridge ? 1 : 0}
          countLabel={t("device:page.rail.countLabel", { count: 1 })}
          active={activeCategory === "hue"}
          onClick={() => setActiveCategory("hue")}
        />
        <RailButton
          icon={<IconWledGlyph />}
          label={t("device:page.rail.wled")}
          count={0}
          active={activeCategory === "wled"}
          onClick={() => setActiveCategory("wled")}
        />
        <RailButton
          icon={<IconDisplayGlyph />}
          label={t("device:page.rail.displays")}
          count={displays.length}
          countLabel={t("device:page.rail.countLabel", { count: displays.length })}
          active={activeCategory === "displays"}
          onClick={() => setActiveCategory("displays")}
        />

        <div className="lm-device-rail-h">{t("device:page.rail.other")}</div>
        <RailButton
          icon={<IconPencil />}
          label={t("device:page.rail.manualEntry")}
          count={0}
          active={activeCategory === "manual"}
          onClick={() => setActiveCategory("manual")}
        />
      </nav>

      {/* ── Main content area ────────────────────────────────── */}
      {/* Every category stays mounted and hides via `hidden`, so switching the
          rail never remounts a category or replays its effects. */}
      <div className="lm-device-main" ref={mainScrollRef}>
        <UsbStripsCategory
          isActive={activeCategory === "usb"}
          device={device}
          pairedStrips={pairedStrips}
          setPairedStrips={setPairedStrips}
          persistError={usbPersistError.active}
          flagPersistError={usbPersistError.raise}
          clearPersistError={usbPersistError.clear}
          onNavigateToRoomMap={onNavigateToRoomMap}
          onChipTypeChange={onChipTypeChange}
        />

        <HueBridgesCategory
          isActive={activeCategory === "hue"}
          hue={hue}
          channelPlacements={channelPlacements}
          onPositionChange={handlePositionChange}
          syncedPositions={syncedPositions}
          onSyncedPositionsChange={handleSyncedPositionsChange}
          onNavigateToRoomMap={onNavigateToRoomMap}
          persistError={hueChannelPersistError.active}
          zones={hueZones}
        />

        <WledCategory isActive={activeCategory === "wled"} />

        <DisplaysCategory isActive={activeCategory === "displays"} displays={displays} />

        <ManualEntryCategory isActive={activeCategory === "manual"} />
      </div>
    </div>
  );
}
