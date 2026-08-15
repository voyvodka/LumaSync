import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shellStore } from "@/features/persistence/shellStore";
import type {
  HueZone,
  HueZoneCommandResult,
  HueZoneStatusCode,
  RoomMapConfig,
} from "@/shared/contracts/roomMap";
import { findHueChannel, isHueZoneApplied } from "@/shared/contracts/roomMap";
import {
  assignChannelToHueZone,
  createHueZone,
  deleteHueZone,
  updateHueZone,
} from "../roomMapApi";

export interface UseRoomMapHueZonesArgs {
  config: RoomMapConfig;
  updateConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  setObjectPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface UseRoomMapHueZonesReturn {
  hueZones: HueZone[];
  activeHueZoneId: string | null;
  activeHueZone: HueZone | null;
  /** Cached active entertainment area id from shellStore — used when authoring Hue zones. */
  hueAreaId: string | null;
  hueBridgeConfigured: boolean;
  /** Code of the last refused mutation, until dismissed. `null` while nothing is refused. */
  hueZoneRejection: HueZoneStatusCode | null;
  dismissHueZoneRejection: () => void;
  handleAddHueZone: () => void;
  handleDeleteHueZone: (zoneId: string) => void;
  handleRenameHueZone: (zoneId: string, name: string) => void;
  handleSelectHueZone: (zoneId: string | null) => void;
  handleAssignChannelToZone: (channelIndex: number, targetZoneId: string | null) => void;
  handleHueZoneCenterChange: (zoneId: string, centerX: number, centerY: number) => void;
  handleHueZoneUpdate: (zoneId: string, patch: Partial<HueZone>) => void;
}

// Hue Zone CRUD. Every handler is local-first and optimistic: the local edit
// lands first, then the backend either confirms it or hands back the pre-image
// it refused, which is re-applied. See docs/architecture/room-map.md.
export function useRoomMapHueZones({
  config,
  updateConfig,
  setSelectedId,
  setObjectPanelOpen,
}: UseRoomMapHueZonesArgs): UseRoomMapHueZonesReturn {
  const { t } = useTranslation();
  const [activeHueZoneId, setActiveHueZoneId] = useState<string | null>(null);
  const [hueAreaId, setHueAreaId] = useState<string | null>(null);

  // "Configured" is `hueAppKey` (legacy plaintext) OR a keychain backend. The
  // editor deliberately stops there — anything beyond needs `useHueOnboarding`,
  // and mounting that state machine here for a header is too much.
  const [hueBridgeConfigured, setHueBridgeConfigured] = useState(false);
  // Load the persisted last-selected entertainment area id once. We do not
  // mount useHueOnboarding here to keep the editor decoupled from the
  // onboarding state machine; the area id alone is enough to author zones.
  useEffect(() => {
    let cancelled = false;
    void shellStore.load().then((state) => {
      if (cancelled) return;
      setHueAreaId(state.lastHueAreaId ?? null);
      const hasKeychain = state.credentialStorageBackend === "keychain";
      const hasLegacyKey = !!state.hueAppKey;
      const hasBridge = !!state.lastHueBridge;
      setHueBridgeConfigured(hasBridge && (hasKeychain || hasLegacyKey));
    });
    return () => { cancelled = true; };
  }, []);

  const hueZones = config.zones;

  const [hueZoneRejection, setHueZoneRejection] = useState<HueZoneStatusCode | null>(null);
  const dismissHueZoneRejection = useCallback(() => setHueZoneRejection(null), []);

  // Settle one mutation against the backend's verdict. `withChannels` is only
  // set for the two commands that own `hueChannels`; the other two return an
  // empty `channels` list that would wipe every placement if written back.
  const settle = useCallback(
    (
      label: string,
      promise: Promise<HueZoneCommandResult>,
      withChannels: boolean,
      onRefused?: () => void,
    ) => {
      void promise
        .then((result) => {
          if (isHueZoneApplied(result.status.code)) return;
          console.warn(
            `[LumaSync] ${label} refused: ${result.status.code} — ${result.status.message}`,
          );
          setHueZoneRejection(result.status.code);
          void updateConfig(
            withChannels
              ? { zones: result.zones, hueChannels: result.channels }
              : { zones: result.zones },
          );
          onRefused?.();
        })
        .catch((e) => {
          console.error(`[LumaSync] ${label} failed`, e);
        });
    },
    [updateConfig],
  );

  const handleAddHueZone = useCallback(() => {
    if (!hueAreaId) return;
    const id = `hue-zone-${crypto.randomUUID()}`;
    const name = t("roomMap:hueZones.defaultName", { N: String(hueZones.length + 1) });
    const palette = ["--lm-zone-1", "--lm-zone-2", "--lm-zone-3", "--lm-zone-4", "--lm-zone-5", "--lm-zone-6"];
    const colorVar = `var(${palette[hueZones.length % palette.length]})`;
    const newZone: HueZone = {
      id,
      name,
      entertainmentAreaId: hueAreaId,
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      scaleZ: 0.5,
      channelIndices: [],
      borderColor: colorVar,
    };
    void updateConfig({ zones: [...config.zones, newZone] });
    setActiveHueZoneId(id);
    setObjectPanelOpen(true);

    settle("create_hue_zone", createHueZone({ zone: newZone, existingZones: hueZones }), false, () => {
      setActiveHueZoneId((current) => (current === id ? null : current));
    });
  }, [hueAreaId, hueZones, config.zones, updateConfig, t, setObjectPanelOpen, settle]);

  const handleDeleteHueZone = useCallback(
    (zoneId: string) => {
      const nextZones = config.zones.filter((z) => z.id !== zoneId);
      // Detach channels that pointed at this zone — they fall back to legacy absolute placement.
      const nextChannels = config.hueChannels.map((ch) =>
        ch.zoneId === zoneId
          ? { ...ch, zoneId: undefined, zoneRelativePosition: undefined }
          : ch,
      );
      void updateConfig({ zones: nextZones, hueChannels: nextChannels });
      if (activeHueZoneId === zoneId) setActiveHueZoneId(null);

      settle(
        "delete_hue_zone",
        deleteHueZone({ zoneId, existingZones: hueZones, channels: config.hueChannels }),
        true,
      );
    },
    [hueZones, config.zones, config.hueChannels, activeHueZoneId, updateConfig, settle],
  );

  const handleRenameHueZone = useCallback(
    (zoneId: string, name: string) => {
      let renamed: HueZone | undefined;
      const next = config.zones.map((z) => {
        if (z.id === zoneId) {
          renamed = { ...z, name };
          return renamed;
        }
        return z;
      });
      void updateConfig({ zones: next });
      if (renamed) {
        settle(
          "update_hue_zone (rename)",
          updateHueZone({ zone: renamed, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, updateConfig, settle],
  );

  // Selection is exclusive between concrete objects and Hue zones, so the
  // inspector and the side-list can never disagree about what is selected.
  const handleSelectHueZone = useCallback((zoneId: string | null) => {
    setActiveHueZoneId(zoneId);
    if (zoneId !== null) setSelectedId(null);
  }, [setSelectedId]);

  // One handler for all three channel→zone paths (both drops and the popover).
  // It writes three fields that must stay in sync — `zoneId`,
  // `zoneRelativePosition`, `channelIndices` — see docs/architecture/room-map.md.
  const handleAssignChannelToZone = useCallback(
    (channelIndex: number, targetZoneId: string | null) => {
      const channel = findHueChannel(config.hueChannels, channelIndex);
      if (!channel) return;
      // No-op if already in the target bucket — avoids spurious invokes.
      const currentZoneId = channel.zoneId ?? null;
      if (currentZoneId === targetZoneId) return;

      // Resolve the entertainment area id we will send to the backend.
      // Prefer the target zone's value when attaching; on detach, keep the
      // channel's last known area (or the persisted `hueAreaId` fallback).
      const targetZone = targetZoneId
        ? hueZones.find((z) => z.id === targetZoneId)
        : null;
      const entertainmentAreaId =
        targetZone?.entertainmentAreaId ?? hueAreaId ?? "";

      // Default zone-relative position lands on the zone center so the
      // dot is visible inside the dashed bounds; the user can drag it
      // afterwards to refine the placement.
      const nextChannels = config.hueChannels.map((c) =>
        c.channelIndex === channelIndex
          ? targetZoneId
            ? {
                ...c,
                zoneId: targetZoneId,
                zoneRelativePosition: { x: 0, y: 0, z: 0 },
              }
            : { ...c, zoneId: undefined, zoneRelativePosition: undefined }
          : c,
      );
      // Keep Hue zones' `channelIndices` in sync — remove from old zone,
      // add to new zone (idempotent). v1.5 W4-F2: only Hue zones live in
      // `config.zones`, so the previous `zoneType !== HUE` skip is gone.
      const nextZones = config.zones.map((z) => {
        const without = z.channelIndices.filter((i) => i !== channelIndex);
        if (z.id === targetZoneId) {
          return { ...z, channelIndices: [...without, channelIndex] };
        }
        return { ...z, channelIndices: without };
      });
      void updateConfig({ hueChannels: nextChannels, zones: nextZones });

      // Pre-mutation lists: the backend performs the same attach itself, and
      // sending `nextZones` made `already_in_zone` always true, which skipped
      // the per-area channel cap entirely.
      settle(
        "assign_channel_to_hue_zone",
        assignChannelToHueZone({
          channelIndex,
          zoneId: targetZoneId,
          zoneRelativePosition: targetZoneId ? { x: 0, y: 0, z: 0 } : null,
          entertainmentAreaId,
          existingZones: config.zones,
          channels: config.hueChannels,
        }),
        true,
      );
    },
    [config.hueChannels, config.zones, hueZones, hueAreaId, updateConfig, settle],
  );

  const activeHueZone: HueZone | null = activeHueZoneId
    ? hueZones.find((z) => z.id === activeHueZoneId) ?? null
    : null;

  const handleHueZoneCenterChange = useCallback(
    (zoneId: string, centerX: number, centerY: number) => {
      let updated: HueZone | undefined;
      const next = config.zones.map((z) => {
        if (z.id === zoneId) {
          updated = { ...z, centerX, centerY };
          return updated;
        }
        return z;
      });
      void updateConfig({ zones: next });
      if (updated) {
        settle(
          "update_hue_zone (center)",
          updateHueZone({ zone: updated, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, updateConfig, settle],
  );

  // The patch passes through verbatim — do NOT mirror one axis onto the other.
  // Zones are physical squares, so the two scales legitimately differ in a
  // non-square room. See docs/architecture/room-map.md.
  const handleHueZoneUpdate = useCallback(
    (zoneId: string, patch: Partial<HueZone>) => {
      let updated: HueZone | undefined;
      const next = config.zones.map((z) => {
        if (z.id === zoneId) {
          updated = { ...z, ...patch };
          return updated;
        }
        return z;
      });
      void updateConfig({ zones: next });
      if (updated) {
        settle(
          "update_hue_zone (props)",
          updateHueZone({ zone: updated, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, updateConfig, settle],
  );

  return {
    hueZones,
    activeHueZoneId,
    activeHueZone,
    hueAreaId,
    hueBridgeConfigured,
    hueZoneRejection,
    dismissHueZoneRejection,
    handleAddHueZone,
    handleDeleteHueZone,
    handleRenameHueZone,
    handleSelectHueZone,
    handleAssignChannelToZone,
    handleHueZoneCenterChange,
    handleHueZoneUpdate,
  };
}
