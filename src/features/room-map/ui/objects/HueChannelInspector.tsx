import { useState } from "react";
import { useTranslation } from "react-i18next";

import { FIXTURE_ORDER, type LampFamily, ONE_SIDED } from "@/features/room-view/model/lampFamily";
import {
  type FurniturePlacement,
  type HueChannelPlacement,
  type HueZone,
  resolveHueFacing,
  resolveHueFixture,
} from "@/shared/contracts/roomMap";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import { furnitureName } from "../../model/furnitureName";
import { hueChannelDotText, hueChannelIdLabel, hueChannelName } from "../../model/hueChannelLabel";
import { hueToMetres, hueToPlanMetres, moveHueChannelToWorld, planMetresToHue, setHueChannelWorldZ } from "../../model/hueChannelPosition";
import { HANGING_FIXTURES, hangHeight, isHung } from "../../model/hueHang";
import { getZoneColor } from "../../model/zoneColor";
import { DecimalField } from "../DecimalField";
import { DockPicker } from "../dock/DockPicker";
import { DockSlider } from "../dock/DockSlider";
import { Actions, Disc, FieldRow, InspectorRows, LinkSlot, Mark, Meta, NameField, Note, RowLink, Status } from "../dock/InspectorParts";
import { FAMILY_KEY } from "../view/viewLightLabel";
import { GlyphHeight, GlyphRotation } from "./fieldGlyphs";
import type { UsbStripConnectionStatus } from "./UsbStripInspector";

const UNASSIGNED = "unassigned";
const AUTO = "auto";
const HEIGHT_WIDTH = 176;
const LINKS_WIDTH = 150;
const wrapDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;
const metresToHue = (metres: number, roomHeight: number) => Math.min(Math.max((metres / roomHeight) * 2 - 1, -1), 1);
/** On the top, give or take a Play bar's middle above it. */
const standsOn = (height: number, top: number) => height >= top - 0.02 && height - top <= 0.15;

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
  onPreview,
  onAssignZone,
  lightCount,
  isGhost = false,
  onRename,
  onToggleLock,
  onClose,
  modelChoices = false,
  bridgeFixture = null,
  autoFacing = 0,
  seat = null,
  onUpdate,
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
  /** Shows the light where a drag across its fields has put it, without saving; false when nothing can. */
  onPreview?: (channel: HueChannelPlacement | null) => boolean;
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
  /** The 3D room is in this build: the model and facing it draws by are offered. */
  modelChoices?: boolean;
  /** The fixture the bridge's archetype names, or `null` when it names none. */
  bridgeFixture?: LampFamily | null;
  /** The facing an unset light takes, in degrees: toward its nearest wall. */
  autoFacing?: number;
  /** The piece under the light and its top, in metres: one click stands the light on it. */
  seat?: { item: FurniturePlacement; top: number } | null;
  /** `worldZ` moves the light with the patch, in the same step: a ceiling light chosen goes up. */
  onUpdate?: (patch: Pick<HueChannelPlacement, "facing" | "fixture">, worldZ?: number) => void;
}) {
  const { t } = useTranslation();
  const locked = !!channel.locked;

  // A drag across a field rebuilt the 3D room each step, as the zone card's did: it is held instead.
  const [dragged, setDragged] = useState<{ x: number; y: number; z: number } | null>(null);
  const at = dragged ?? { x: world.x, y: world.y, z: worldZ };
  const minZ = heightRange?.min ?? -1;
  const maxZ = heightRange?.max ?? 1;
  const limitingZone = heightRange?.zone && (minZ > -1 || maxZ < 1) ? heightRange.zone : null;
  const shownZ = Math.min(maxZ, Math.max(minZ, at.z));
  /** Slider stays in Hue's [-1, 1]; only the readout is metres, because that is
   *  the unit the rest of the map speaks and `-0.42` names nothing a person owns. */
  const heightMetres = (z: number) => hueToMetres(z, roomHeightMeters).toFixed(2);
  // Metres on the plan, as every other object's position reads; the cube's [-1, 1] stays inside.
  const plan = hueToPlanMetres(at, roomWidthMeters, roomDepthMeters);
  const hold = (next: { x: number; y: number; z: number }) => {
    const moved = moveHueChannelToWorld(channel, zones, next.x, next.y);
    if (!onPreview?.(next.z === worldZ ? moved : setHueChannelWorldZ(moved, zones, next.z))) return false;
    setDragged(next);
    return true;
  };
  const moveTo = (x: number, y: number, held = false) => {
    const next = planMetresToHue(x, y, roomWidthMeters, roomDepthMeters);
    if (!held || !hold({ ...at, x: next.x, y: next.y })) onMove(next.x, next.y);
  };
  // Each step saved rebuilt the room, and turning a light stuttered: held like the position.
  const [heldFacing, setHeldFacing] = useState<{ value: number | undefined } | null>(null);
  const turnTo = (facing: number | undefined, held = false) => {
    if (held && onPreview?.({ ...channel, facing })) return setHeldFacing({ value: facing });
    onUpdate?.({ facing });
  };
  const letGoFacing = () => {
    if (!heldFacing) return;
    setHeldFacing(null);
    if (heldFacing.value === resolveHueFacing(channel)) return void onPreview?.(null);
    onUpdate?.({ facing: heldFacing.value });
  };
  const raiseTo = (z: number) => {
    if (!hold({ ...at, z })) onHeightChange(z);
  };
  // Saved on release, and held until the room is built with it, as a zone is.
  const letGo = () => {
    if (!dragged) return;
    setDragged(null);
    const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    if (same(dragged.x, world.x) && same(dragged.y, world.y) && same(dragged.z, worldZ)) return void onPreview?.(null);
    if (!same(dragged.x, world.x) || !same(dragged.y, world.y)) onMove(dragged.x, dragged.y);
    if (!same(dragged.z, worldZ)) onHeightChange(dragged.z);
  };

  const fixture = resolveHueFixture(channel);
  const drawnAs = fixture ?? bridgeFixture ?? "bulb";
  const oneSided = ONE_SIDED.has(drawnAs);
  const shownMetres = hueToMetres(shownZ, roomHeightMeters);
  /** Where `family` hangs in the cube, or null when it stands, is hung already, or its zone stops short. */
  const hangZ = (family: LampFamily): number | null => {
    const metres = hangHeight(family, roomHeightMeters);
    if (metres === null || isHung(family, shownMetres, roomHeightMeters)) return null;
    const z = metresToHue(metres, roomHeightMeters);
    return z <= maxZ + 0.005 ? Math.max(minZ, z) : null;
  };
  // A bulb on a piece is a lamp's: offering the ceiling too would contradict "Stand on".
  const hangTo = drawnAs === "bulb" && seat ? null : hangZ(drawnAs);
  const pickFixture = (next: LampFamily | typeof AUTO) => {
    const picked = next === AUTO ? undefined : next;
    const family = picked ?? bridgeFixture ?? "bulb";
    onUpdate?.({ fixture: picked }, HANGING_FIXTURES.has(family) ? (hangZ(family) ?? undefined) : undefined);
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
              onCommit={(x, held) => moveTo(x, plan.y, held)}
              onScrubEnd={letGo}
            />
            <DecimalField
              label={t("roomMap:inspector.yLabel")}
              prefix="Y"
              value={plan.y}
              min={0}
              max={roomDepthMeters}
              unit="m"
              disabled={locked}
              onCommit={(y, held) => moveTo(plan.x, y, held)}
              onScrubEnd={letGo}
            />
          </FieldRow>
          <DockSlider
            label={t("roomMap:inspector.hueHeightAriaLabel")}
            prefix={<GlyphHeight />}
            width={HEIGHT_WIDTH}
            min={minZ}
            max={maxZ}
            step={0.01}
            value={shownZ}
            disabled={locked || maxZ <= minZ}
            onChange={raiseTo}
            onCommit={letGo}
            // The raw -1..1 is meaningless read aloud; this is the whole reason the
            // control moved off the Devices strip, so do not drop it.
            ariaValueText={t("roomMap:inspector.hueHeightValueText", {
              metres: heightMetres(shownZ),
              label: t(heightBandKey(shownZ)),
            })}
            readout={t("roomMap:inspector.hueHeightReadout", { metres: heightMetres(shownZ) })}
            note={
              limitingZone ? t("roomMap:inspector.hueHeightZoneShort", { min: heightMetres(minZ), max: heightMetres(maxZ) }) : undefined
            }
          />
          {/* Held while empty: a link that came with a new height shrank the slider under the thumb. */}
          <LinkSlot width={LINKS_WIDTH}>
            {hangTo !== null && !locked && <RowLink onClick={() => onHeightChange(hangTo)}>{t("roomMap:inspector.hueHang")}</RowLink>}
            {seat && !HANGING_FIXTURES.has(drawnAs) && !standsOn(shownMetres, seat.top) && !locked && (
              <RowLink onClick={() => onHeightChange(metresToHue(seat.top, roomHeightMeters))}>
                {t("roomMap:inspector.hueSeatOn", {
                  name: furnitureName(seat.item, t),
                })}
              </RowLink>
            )}
          </LinkSlot>
          {modelChoices && onUpdate && (
            <FieldRow>
              <DockPicker<LampFamily | typeof AUTO>
                label={t("roomMap:inspector.modelLabel")}
                value={fixture ?? AUTO}
                width={176}
                disabled={locked}
                note={t("roomMap:inspector.hueModelInfo")}
                options={[
                  {
                    value: AUTO,
                    label: bridgeFixture
                      ? t("roomMap:inspector.modelAuto", { model: t(FAMILY_KEY[bridgeFixture]) })
                      : t("roomMap:inspector.hueModelAutoUnknown"),
                  },
                  ...FIXTURE_ORDER.map((value) => ({ value, label: t(FAMILY_KEY[value]) })),
                ]}
                onChange={pickFixture}
              />
              {/* Always in its place, so the row reads the same from one light to the next. */}
              <DecimalField
                optional
                label={t("roomMap:inspector.hueFacingLabel")}
                tip={oneSided ? t("roomMap:inspector.hueFacingInfo", { degrees: autoFacing }) : t("roomMap:inspector.hueFacingNone")}
                prefix={<GlyphRotation />}
                value={oneSided ? (heldFacing ? heldFacing.value : resolveHueFacing(channel)) : undefined}
                placeholder={oneSided ? String(autoFacing) : "–"}
                decimals={0}
                step={15}
                min={0}
                max={359}
                normalize={wrapDegrees}
                unit="°"
                disabled={locked || !oneSided}
                onCommit={turnTo}
                onScrubEnd={letGoFacing}
              />
            </FieldRow>
          )}
        </>
      }
    />
  );
}
