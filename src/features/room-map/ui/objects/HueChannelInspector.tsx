import { useTranslation } from "react-i18next";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import { hueChannelDotText, hueChannelIdLabel, hueChannelName } from "../../model/hueChannelLabel";
import { hueToMetres, hueToPlanMetres, planMetresToHue } from "../../model/hueChannelPosition";
import { getZoneColor } from "../../model/zoneColor";
import { DecimalField } from "../DecimalField";
import { DockPicker } from "../dock/DockPicker";
import { DockSlider } from "../dock/DockSlider";
import { Actions, Disc, FieldRow, InspectorRows, Mark, Meta, NameField, Note, Status } from "../dock/InspectorParts";
import { GlyphHeight } from "./fieldGlyphs";
import type { UsbStripConnectionStatus } from "./UsbStripInspector";

const UNASSIGNED = "unassigned";

function heightBandKey(
  worldZ: number,
):
  | "roomMap:inspector.hueHeightFloor"
  | "roomMap:inspector.hueHeightEye"
  | "roomMap:inspector.hueHeightCeiling" {
  if (worldZ <= -0.34) return "roomMap:inspector.hueHeightFloor";
  if (worldZ >= 0.34) return "roomMap:inspector.hueHeightCeiling";
  return "roomMap:inspector.hueHeightEye";
}

export function HueChannelInspector({
  channel,
  zones,
  bridgeStatus = "unknown",
  world,
  worldZ,
  heightRange,
  roomWidthMeters,
  roomDepthMeters,
  roomHeightMeters,
  onMove,
  onHeightChange,
  onAssignZone,
  lightCount,
  isGhost = false,
  onRename,
  onToggleLock,
  onClose,
}: {
  channel: HueChannelPlacement;
  /** The zones of the channel's area, the ones it can join. */
  zones: readonly HueZone[];
  /** Resolved position in the cube — a zone-bound channel's live value is zone-relative. */
  world: { x: number; y: number };
  /** Resolved height — a zone-bound channel's live value is zone-relative. */
  worldZ: number;
  /** Heights the channel can reach; a bound zone narrows it. Default [-1, 1]. */
  heightRange?: { min: number; max: number; zone: HueZone | null };
  roomWidthMeters: number;
  roomDepthMeters: number;
  roomHeightMeters: number;
  /** A new position in the cube; the editor writes whichever field is live. */
  onMove: (worldX: number, worldY: number) => void;
  onHeightChange: (worldZ: number) => void;
  /** Joins a zone, or leaves one for `null`. Absent leaves membership read-only. */
  onAssignZone?: (zoneId: string | null) => void;
  /** Hue bridge reachability, in the strip inspector's words. `unknown` (default) shows none. */
  bridgeStatus?: UsbStripConnectionStatus;
  /** How many bulbs this channel drives, from the bridge. `null` when the
   *  channel is not in the area the bridge reports — see `isGhost`. */
  lightCount?: number | null;
  /** True when the bridge no longer reports this channel. Distinct from an
   *  unresolved placement, which was never matched to one at all. */
  isGhost?: boolean;
  onRename: (label: string) => void;
  onToggleLock: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!channel.locked;

  const minZ = heightRange?.min ?? -1;
  const maxZ = heightRange?.max ?? 1;
  const limitingZone = heightRange?.zone && (minZ > -1 || maxZ < 1) ? heightRange.zone : null;
  const shownZ = Math.min(maxZ, Math.max(minZ, worldZ));
  /** Slider stays in Hue's [-1, 1]; only the readout is metres, because that is
   *  the unit the rest of the map speaks and `-0.42` names nothing a person owns. */
  const heightMetres = (z: number) => hueToMetres(z, roomHeightMeters).toFixed(2);
  // Metres on the plan, as every other object's position reads; the cube's [-1, 1] stays inside.
  const plan = hueToPlanMetres(world, roomWidthMeters, roomDepthMeters);
  const moveTo = (x: number, y: number) => {
    const next = planMetresToHue(x, y, roomWidthMeters, roomDepthMeters);
    onMove(next.x, next.y);
  };

  const zoneIndex = channel.zoneId ? zones.findIndex((z) => z.id === channel.zoneId) : -1;
  const zone = zoneIndex >= 0 ? zones[zoneIndex] : undefined;
  const facts = [
    hueChannelIdLabel(channel.channelId) ?? t("roomMap:inspector.hueChannelUnresolved"),
    lightCount == null ? null : lightCount === 1 ? t("roomMap:inspector.hueOneLight") : t("roomMap:inspector.hueLights", { count: lightCount }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <Disc fill="rgb(255 255 255 / 80%)" ring={zone ? getZoneColor(zone, zoneIndex) : undefined} ghost={isGhost}>
              {hueChannelDotText(channel.channelId)}
            </Disc>
          </Mark>
          <NameField
            first
            value={channel.label ?? undefined}
            fallback={hueChannelName({ channelId: channel.channelId }, t)}
            label={t("roomMap:inspector.furnitureNameLabel")}
            disabled={locked}
            onCommit={onRename}
          />
          <Status>
            {isGhost ? (
              <Note tone="warning" title={t("roomMap:inspector.hueChannelGhostNote")}>
                {t("roomMap:inspector.hueGhostShort")}
              </Note>
            ) : (
              <>
                {bridgeStatus !== "unknown" && (
                  <StateWord tone={bridgeStatus === "connected" ? "live" : "idle"}>
                    <span className="sr-only">{t("roomMap:inspector.hueBridgeLabel")}: </span>
                    {bridgeStatus === "connected" ? t("roomMap:inspector.hueBridgeConnected") : t("roomMap:inspector.hueBridgeDisconnected")}
                  </StateWord>
                )}
                <Meta>{facts}</Meta>
              </>
            )}
          </Status>
          <DockPicker
            label={t("roomMap:inspector.hueZoneLabel")}
            value={zone?.id ?? UNASSIGNED}
            width={150}
            disabled={locked || !onAssignZone || zones.length === 0}
            options={[
              { value: UNASSIGNED, label: t("roomMap:hueZones.unassignedTitle"), mark: <Disc /> },
              ...zones.map((z, i) => ({ value: z.id, label: z.name, mark: <Disc fill={getZoneColor(z, i)} /> })),
            ]}
            onChange={(next) => onAssignZone?.(next === UNASSIGNED ? null : next)}
          />
          <Actions locked={locked} onToggleLock={onToggleLock} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField
              label={t("roomMap:inspector.xLabel")}
              prefix="X"
              value={plan.x}
              min={0}
              max={roomWidthMeters}
              unit="m"
              disabled={locked}
              onCommit={(x) => moveTo(x, plan.y)}
            />
            <DecimalField
              label={t("roomMap:inspector.yLabel")}
              prefix="Y"
              value={plan.y}
              min={0}
              max={roomDepthMeters}
              unit="m"
              disabled={locked}
              onCommit={(y) => moveTo(plan.x, y)}
            />
          </FieldRow>
          <DockSlider
            label={t("roomMap:inspector.hueHeightAriaLabel")}
            prefix={<GlyphHeight />}
            min={minZ}
            max={maxZ}
            step={0.01}
            value={shownZ}
            disabled={locked || maxZ <= minZ}
            onChange={onHeightChange}
            // The raw -1..1 is meaningless read aloud; this is the whole reason the
            // control moved off the Devices strip, so do not drop it.
            ariaValueText={t("roomMap:inspector.hueHeightValueText", {
              metres: heightMetres(shownZ),
              label: t(heightBandKey(shownZ)),
            })}
            readout={t("roomMap:inspector.hueHeightReadout", { metres: heightMetres(shownZ) })}
          />
          {limitingZone && (
            <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.hueHeightLabel") })}>
              {t("roomMap:inspector.hueHeightZoneLimit", {
                name: limitingZone.name,
                min: heightMetres(minZ),
                max: heightMetres(maxZ),
              })}
            </InfoTip>
          )}
        </>
      }
    />
  );
}
