import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HueChannelPlacement,
  HueZone,
  HueZoneCommandResult,
  HueZoneStatusCode,
  RoomMapConfig,
  ZoneRelativePosition,
} from "@/shared/contracts/roomMap";
import { isHueZoneApplied, replaceHueChannel } from "@/shared/contracts/roomMap";
import { detachHueChannel } from "../model/hueChannelPosition";
import { findScopedHueChannel } from "../model/hueChannelScope";
import { zoneToken } from "../model/zoneColor";
import { bottomKeptCenterZ, withCubeScale } from "../model/zoneCube";
import type { CubeFootprint } from "../model/zoneRect";
import {
  assignChannelToHueZone,
  createHueZone,
  deleteHueZone,
  updateHueZone,
} from "../roomMapApi";
import type { RoomMapPatch } from "./roomMapReducer";
import type { ApplyOptions } from "./useRoomMapState";

export interface UseRoomMapHueZonesArgs {
  config: RoomMapConfig;
  apply: (patch: RoomMapPatch, options?: ApplyOptions) => void;
  /** Re-applying the pre-image of a refused mutation is not an edit the user made. */
  adopt: (patch: RoomMapPatch) => void;
  activeHueZoneId: string | null;
  selectHueZone: (zoneId: string | null) => void;
  /** The area new zones are authored in (`useRoomMapHueArea`); `null` adds nothing. */
  hueAreaId: string | null;
}

export interface UseRoomMapHueZonesReturn {
  hueZones: HueZone[];
  activeHueZone: HueZone | null;
  /** Code of the last refused mutation, until dismissed. `null` while nothing is refused. */
  hueZoneRejection: HueZoneStatusCode | null;
  dismissHueZoneRejection: () => void;
  /** Without `footprint`, the cube of scale 0.5 at the room's middle. */
  handleAddHueZone: (footprint?: CubeFootprint) => void;
  handleDeleteHueZone: (zoneId: string) => void;
  handleRenameHueZone: (zoneId: string, name: string) => void;
  /** Without `dropped`, the stored light lands at the zone's middle. */
  handleAssignChannelToZone: (channelIndex: number, targetZoneId: string | null, dropped?: DroppedLight) => void;
  /** `held`: a key's run of steps, one undo step and one save. Without `centerZ`, its height stays. */
  handleHueZoneCenterChange: (zoneId: string, centerX: number, centerY: number, held?: boolean, centerZ?: number) => void;
  handleHueZoneUpdate: (zoneId: string, patch: Partial<HueZone>) => void;
  /** One undo step per release: unlike a field's stream, two resizes a beat apart must not merge.
   *  Without `centerZ`, its bottom stays. */
  handleHueZoneResize: (zoneId: string, footprint: CubeFootprint & { centerZ?: number }) => void;
}

const SHAPE_KEYS = ["centerX", "centerY", "centerZ", "scaleX", "scaleY", "scaleZ"] as const;

export interface DroppedLight {
  channel: HueChannelPlacement;
  at: ZoneRelativePosition;
}

// Hue Zone CRUD. Every handler is local-first and optimistic: the local edit
// lands first, then the backend either confirms it or hands back the pre-image
// it refused, which is re-applied. See docs/architecture/room-map.md.
export function useRoomMapHueZones({
  config,
  apply,
  adopt,
  activeHueZoneId,
  selectHueZone,
  hueAreaId,
}: UseRoomMapHueZonesArgs): UseRoomMapHueZonesReturn {
  const { t } = useTranslation();

  const hueZones = config.zones;

  const [hueZoneRejection, setHueZoneRejection] = useState<HueZoneStatusCode | null>(null);
  const dismissHueZoneRejection = useCallback(() => setHueZoneRejection(null), []);

  // Settle one mutation against the backend's verdict. `withChannels` is only
  // set for the two commands that own `hueChannels`; the other two return an
  // empty `channels` list that would wipe every placement if written back.
  // The pre-image is adopted rather than applied: as an undo step it would let
  // Cmd+Z restore the very state the backend refused. Adopting it also drops
  // the selection of a zone the refusal took away.
  const settle = useCallback(
    (label: string, promise: Promise<HueZoneCommandResult>, withChannels: boolean) => {
      void promise
        .then((result) => {
          if (isHueZoneApplied(result.status.code)) return;
          console.warn(
            `[LumaSync] ${label} refused: ${result.status.code} — ${result.status.message}`,
          );
          setHueZoneRejection(result.status.code);
          adopt(
            withChannels
              ? { zones: result.zones, hueChannels: result.channels }
              : { zones: result.zones },
          );
        })
        .catch((e) => {
          console.error(`[LumaSync] ${label} failed`, e);
        });
    },
    [adopt],
  );

  const handleAddHueZone = useCallback((footprint?: CubeFootprint) => {
    if (!hueAreaId) return;
    const id = `hue-zone-${crypto.randomUUID()}`;
    const name = t("roomMap:hueZones.defaultName", { N: String(hueZones.length + 1) });
    const draft: HueZone = {
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
      borderColor: zoneToken(hueZones.length),
    };
    const newZone = withCubeScale(draft, footprint?.scale ?? 0.5, { x: footprint?.centerX ?? 0, y: footprint?.centerY ?? 0, z: 0 });
    apply({ zones: [...config.zones, newZone] });
    selectHueZone(id);

    settle("create_hue_zone", createHueZone({ zone: newZone, existingZones: hueZones }), false);
  }, [hueAreaId, hueZones, config.zones, apply, t, selectHueZone, settle]);

  const handleDeleteHueZone = useCallback(
    (zoneId: string) => {
      const nextZones = config.zones.filter((z) => z.id !== zoneId);
      const nextChannels = config.hueChannels.map((ch) => (ch.zoneId === zoneId ? detachHueChannel(ch, config.zones) : ch));
      apply({ zones: nextZones, hueChannels: nextChannels });

      settle(
        "delete_hue_zone",
        deleteHueZone({ zoneId, existingZones: hueZones, channels: config.hueChannels }),
        true,
      );
    },
    [hueZones, config.zones, config.hueChannels, apply, settle],
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
      apply({ zones: next });
      if (renamed) {
        settle(
          "update_hue_zone (rename)",
          updateHueZone({ zone: renamed, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, apply, settle],
  );

  // One handler for both channel→zone paths (the light's zone picker and the zone's light chips).
  // It writes three fields that must stay in sync — `zoneId`,
  // `zoneRelativePosition`, `channelIndices` — see docs/architecture/room-map.md.
  const handleAssignChannelToZone = useCallback(
    (channelIndex: number, targetZoneId: string | null, dropped?: DroppedLight) => {
      const channel = dropped?.channel ?? findScopedHueChannel(config.hueChannels, hueAreaId, channelIndex);
      const at = dropped?.at ?? { x: 0, y: 0, z: 0 };
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
      if (targetZoneId && !targetZone) return;
      // A zone holds its own area's lights: across areas the channel would point at a zone whose
      // `channelIndices` the sync below leaves alone, the desync the backend refuses.
      if (targetZone && channel.entertainmentAreaId && targetZone.entertainmentAreaId !== channel.entertainmentAreaId) {
        return;
      }
      const entertainmentAreaId =
        targetZone?.entertainmentAreaId ?? hueAreaId ?? "";

      const nextChannels = replaceHueChannel(
        config.hueChannels,
        targetZoneId
          ? { ...channel, zoneId: targetZoneId, zoneRelativePosition: at }
          : detachHueChannel(channel, config.zones),
      );
      // Keep Hue zones' `channelIndices` in sync — remove from old zone,
      // add to new zone (idempotent). Only Hue zones live in
      // `config.zones`, so the previous `zoneType !== HUE` skip is gone.
      // A zone of another area holding the same index names a different channel.
      const channelAreaId = channel.entertainmentAreaId || entertainmentAreaId;
      const nextZones = config.zones.map((z) => {
        if (channelAreaId && z.entertainmentAreaId !== channelAreaId) return z;
        const without = z.channelIndices.filter((i) => i !== channelIndex);
        if (z.id === targetZoneId) {
          return { ...z, channelIndices: [...without, channelIndex] };
        }
        return { ...z, channelIndices: without };
      });
      apply({ hueChannels: nextChannels, zones: nextZones });

      // Pre-mutation lists: the backend performs the same attach itself, and
      // sending `nextZones` made `already_in_zone` always true, which skipped
      // the per-area channel cap entirely.
      settle(
        "assign_channel_to_hue_zone",
        assignChannelToHueZone({
          channelIndex,
          zoneId: targetZoneId,
          zoneRelativePosition: targetZoneId ? at : null,
          entertainmentAreaId,
          existingZones: config.zones,
          channels: config.hueChannels,
        }),
        true,
      );
    },
    [config.hueChannels, config.zones, hueZones, hueAreaId, apply, settle],
  );

  const activeHueZone: HueZone | null = activeHueZoneId
    ? hueZones.find((z) => z.id === activeHueZoneId) ?? null
    : null;

  const handleHueZoneCenterChange = useCallback(
    (zoneId: string, centerX: number, centerY: number, held = false, centerZ?: number) => {
      let updated: HueZone | undefined;
      const next = config.zones.map((z) => {
        if (z.id === zoneId) {
          updated = withCubeScale(z, z.scaleX, { x: centerX, y: centerY, z: centerZ ?? z.centerZ });
          return updated;
        }
        return z;
      });
      apply({ zones: next }, held ? { gesture: `hue-zone:${zoneId}:centerX,centerY` } : undefined);
      if (updated) {
        settle(
          "update_hue_zone (center)",
          updateHueZone({ zone: updated, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, apply, settle],
  );

  // A patch that touches its shape is made a cube again, taking `scaleX` as the size.
  const handleHueZoneUpdate = useCallback(
    (zoneId: string, patch: Partial<HueZone>) => {
      let updated: HueZone | undefined;
      const next = config.zones.map((z) => {
        if (z.id === zoneId) {
          const merged = { ...z, ...patch };
          updated = SHAPE_KEYS.some((key) => key in patch)
            ? withCubeScale(merged, merged.scaleX, { x: merged.centerX, y: merged.centerY, z: merged.centerZ })
            : merged;
          return updated;
        }
        return z;
      });
      // The size slider and the colour picker land here once per input event;
      // the gesture keeps a drag across either one undo step and one save.
      apply({ zones: next }, { gesture: `hue-zone:${zoneId}:${Object.keys(patch).sort().join(",")}` });
      if (updated) {
        settle(
          "update_hue_zone (props)",
          updateHueZone({ zone: updated, existingZones: config.zones }),
          false,
        );
      }
    },
    [config.zones, apply, settle],
  );

  const handleHueZoneResize = useCallback(
    (zoneId: string, footprint: CubeFootprint & { centerZ?: number }) => {
      const zone = config.zones.find((z) => z.id === zoneId);
      if (!zone) return;
      const z = footprint.centerZ ?? bottomKeptCenterZ(zone, footprint.scale);
      const updated = withCubeScale(zone, footprint.scale, { x: footprint.centerX, y: footprint.centerY, z });
      apply({ zones: config.zones.map((z) => (z.id === zoneId ? updated : z)) });
      settle("update_hue_zone (resize)", updateHueZone({ zone: updated, existingZones: config.zones }), false);
    },
    [config.zones, apply, settle],
  );

  return {
    hueZones,
    activeHueZone,
    hueZoneRejection,
    dismissHueZoneRejection,
    handleAddHueZone,
    handleDeleteHueZone,
    handleRenameHueZone,
    handleAssignChannelToZone,
    handleHueZoneCenterChange,
    handleHueZoneUpdate,
    handleHueZoneResize,
  };
}
