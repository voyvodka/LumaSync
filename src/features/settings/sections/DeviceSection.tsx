import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DisplayInfo } from "@/shared/contracts/display";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type {
  HueChannelPlacement,
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
}

export function DeviceSection({ onNavigateToRoomMap }: DeviceSectionProps = {}) {
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
      setChannelPlacements(state.roomMap?.hueChannels ?? []);
      setPairedStrips(state.roomMap?.usbStrips ?? []);
    });
    return () => { cancelled = true; };
  }, [selectedAreaId]);

  // -------------------------------------------------------------------------
  // Phase 7: category rail + displays list
  // -------------------------------------------------------------------------
  const [activeCategory, setActiveCategory] = useState<DeviceCategory>("usb");
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
    setChannelPlacements(updated);
    try {
      const current = await shellStore.load();
      const currentRoomMap = current.roomMap;
      const updatedRoomMap: RoomMapConfig = {
        ...(currentRoomMap ?? DEFAULT_ROOM_MAP),
        hueChannels: updated,
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
  }, [hueChannelPersistError]);

  return (
    <div className="lm-device-page">
      {/* ── Left category rail ───────────────────────────────── */}
      <nav className="lm-device-rail">
        <div className="lm-device-rail-h">{t("device:page.rail.connected")}</div>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "usb" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("usb")}
        >
          <span className="lm-device-cat-ic"><IconUsb /></span>
          <span className="lm-device-cat-tx">{t("device:page.rail.usbStrips")}</span>
          {ports.length > 0 ? <span className="lm-device-cat-cnt">{ports.length}</span> : null}
        </button>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "hue" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("hue")}
        >
          <span className="lm-device-cat-ic"><IconHueBridgeGlyph /></span>
          <span className="lm-device-cat-tx">{t("device:page.rail.hueBridges")}</span>
          {selectedBridge ? <span className="lm-device-cat-cnt">1</span> : null}
        </button>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "wled" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("wled")}
        >
          <span className="lm-device-cat-ic"><IconWledGlyph /></span>
          <span className="lm-device-cat-tx">{t("device:page.rail.wled")}</span>
        </button>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "displays" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("displays")}
        >
          <span className="lm-device-cat-ic"><IconDisplayGlyph /></span>
          <span className="lm-device-cat-tx">{t("device:page.rail.displays")}</span>
          {displays.length > 0 ? <span className="lm-device-cat-cnt">{displays.length}</span> : null}
        </button>

        <div className="lm-device-rail-h">{t("device:page.rail.other")}</div>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "manual" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("manual")}
        >
          <span className="lm-device-cat-ic"><IconPencil /></span>
          <span className="lm-device-cat-tx">{t("device:page.rail.manualEntry")}</span>
        </button>
      </nav>

      {/* ── Main content area ────────────────────────────────── */}
      {/* Every category stays mounted and hides via `hidden`, so switching the
          rail never remounts a category or replays its effects. */}
      <div className="lm-device-main">
        <UsbStripsCategory
          isActive={activeCategory === "usb"}
          device={device}
          pairedStrips={pairedStrips}
          setPairedStrips={setPairedStrips}
          persistError={usbPersistError.active}
          flagPersistError={usbPersistError.raise}
          clearPersistError={usbPersistError.clear}
          onNavigateToRoomMap={onNavigateToRoomMap}
        />

        <HueBridgesCategory
          isActive={activeCategory === "hue"}
          hue={hue}
          channelPlacements={channelPlacements}
          onPositionChange={handlePositionChange}
          persistError={hueChannelPersistError.active}
        />

        <WledCategory isActive={activeCategory === "wled"} />

        <DisplaysCategory isActive={activeCategory === "displays"} displays={displays} />

        <ManualEntryCategory isActive={activeCategory === "manual"} />
      </div>
    </div>
  );
}
