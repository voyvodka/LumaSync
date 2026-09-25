import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import type { DisplayInfo } from "@/shared/contracts/display";
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
import { listDisplays } from "@/features/calibration/calibrationApi";
import { useDeviceConnection } from "@/features/device/useDeviceConnection";
import { useHueOnboarding } from "@/features/hue/useHueOnboarding";
import { DisplaysCategory } from "./device/DisplaysCategory";
import { HueBridgesCategory } from "./device/HueBridgesCategory";
import { UsbStripsCategory } from "./device/UsbStripsCategory";
import { useActiveWledSink } from "@/features/device/useWledSink";
import { WledCategory } from "./device/WledCategory";
import { useTransientFlag } from "./device/useTransientFlag";
import {
  IconUsb,
  IconHueBridgeGlyph,
  IconDisplayGlyph,
  IconWledGlyph,
} from "@/shared/ui/icons";
import { parseCommandError } from "@/shared/contracts/status";
import type { TranslationKey } from "@/features/i18n/catalogue";

export type DeviceCategory = "usb" | "hue" | "wled" | "displays";

type RailGroup = "devices";

export interface DeviceCategoryDescriptor {
  group: RailGroup;
  Icon: ComponentType;
  labelKey: TranslationKey;
}

/** The Devices rail in order, one row per category: a new category fails to compile until it has one. */
export const DEVICE_CATEGORIES = {
  usb: { group: "devices", Icon: IconUsb, labelKey: "device:page.rail.usbStrips" },
  hue: { group: "devices", Icon: IconHueBridgeGlyph, labelKey: "device:page.rail.hueBridges" },
  wled: { group: "devices", Icon: IconWledGlyph, labelKey: "device:page.rail.wled" },
  displays: { group: "devices", Icon: IconDisplayGlyph, labelKey: "device:page.rail.displays" },
} satisfies Record<DeviceCategory, DeviceCategoryDescriptor>;

function deviceCategory(category: DeviceCategory): DeviceCategoryDescriptor {
  return DEVICE_CATEGORIES[category];
}

const RAIL_GROUP_HEADINGS = {
  devices: "device:page.rail.devices",
} satisfies Record<RailGroup, TranslationKey>;

const DEVICE_RAIL_GROUPS = (Object.keys(RAIL_GROUP_HEADINGS) as RailGroup[]).map((group) => ({
  headingKey: RAIL_GROUP_HEADINGS[group],
  categories: (Object.keys(DEVICE_CATEGORIES) as DeviceCategory[]).filter(
    (category) => deviceCategory(category).group === group,
  ),
}));

/** A deep link into one category. The nonce makes asking twice for the same one count. */
export interface DeviceCategoryRequest {
  category: DeviceCategory;
  nonce: number;
}

export interface DeviceSectionProps {
  /**
   * Deep-link the user from the "Paired strips" sub-card
   * back to the Room Map editor where the strip's placement and LED
   * count live. Inert when omitted.
   */
  onNavigateToRoomMap?: () => void;
  /** Forwarded to the Hue card; see `HueBridgesCategoryProps.onStopHue`. */
  onStopHueOutput: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  /** Opens a category from outside, e.g. a notice's "Devices" action for Hue. */
  categoryRequest?: DeviceCategoryRequest | null;
  /** The category on view, and `null` on unmount; the shell's notices defer to it. */
  onVisibleCategoryChange?: (category: DeviceCategory | null) => void;
  /** A bridge is paired and Hue is streaming: what the Hue badge counts. */
  hueActive?: boolean;
  /** Ambilight runs, so Displays marks its source as being captured. */
  ambilightActive?: boolean;
  /** Displays links to the display picker, which lives in LED Setup. */
  onOpenLedSetup?: () => void;
}

interface RailButtonProps {
  /** Also names the button for e2e: `device-category-<category>`. */
  category: DeviceCategory;
  icon: React.ReactNode;
  label: string;
  /** How many are active; rendered as a badge when non-zero. */
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
function RailButton({ category, icon, label, count, countLabel, active, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      data-testid={`device-category-${category}`}
      className="lm-device-cat"
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

export function DeviceSection({
  onNavigateToRoomMap,
  onStopHueOutput,
  categoryRequest = null,
  onVisibleCategoryChange,
  hueActive = false,
  ambilightActive = false,
  onOpenLedSetup,
}: DeviceSectionProps) {
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
        console.error("[LumaSync] DeviceSection: loading room-map placements failed:", error);
      });
    return () => { cancelled = true; };
  }, [selectedAreaId]);

  // -------------------------------------------------------------------------
  // Category rail + displays list
  // -------------------------------------------------------------------------
  const [activeCategory, setActiveCategory] = useState<DeviceCategory>(categoryRequest?.category ?? "usb");
  const [handledRequest, setHandledRequest] = useState(categoryRequest);
  if (categoryRequest !== handledRequest) {
    setHandledRequest(categoryRequest);
    if (categoryRequest !== null) setActiveCategory(categoryRequest.category);
  }

  // Layout effects, so a notice this page already shows is gone before paint.
  useLayoutEffect(() => {
    onVisibleCategoryChange?.(activeCategory);
  }, [activeCategory, onVisibleCategoryChange]);
  useLayoutEffect(() => () => onVisibleCategoryChange?.(null), [onVisibleCategoryChange]);

  // One scroller serves every category — they only toggle `hidden` — so the
  // offset carries over and a taller category opens past its own heading.
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeCategory is the trigger that resets the shared scroller
  useEffect(() => {
    const main = mainScrollRef.current;
    if (main) main.scrollTop = 0;
  }, [activeCategory]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  // The room-map editor authors strips on its own surface; re-hydrating here
  // catches those edits without coupling the two stores.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectedPort is the trigger that re-reads strips paired elsewhere
  useEffect(() => {
    if (activeCategory !== "usb") return;
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setPairedStrips(state.roomMap?.usbStrips ?? []);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] DeviceSection: re-reading paired USB strips failed:", error);
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
        const reason = parseCommandError(error).message;
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

  // Every badge counts what is active, never what merely exists: an
  // enumerated port or a paired-but-idle bridge put a number beside a header
  // saying nothing was connected. Displays have no such state.
  const railCounts: Record<DeviceCategory, number> = {
    usb: connectedPort ? 1 : 0,
    hue: hueActive ? 1 : 0,
    wled: activeWledIp === null ? 0 : 1,
    displays: 0,
  };

  return (
    <div className="lm-device-page">
      {/* ── Left category rail ───────────────────────────────── */}
      <nav className="lm-device-rail">
        {DEVICE_RAIL_GROUPS.map(({ headingKey, categories }) => (
          <Fragment key={headingKey}>
            <div className="lm-device-rail-h">{t(headingKey)}</div>
            {categories.map((category) => {
              const { Icon, labelKey } = deviceCategory(category);
              const count = railCounts[category];
              return (
                <RailButton
                  key={category}
                  category={category}
                  icon={<Icon />}
                  label={t(labelKey)}
                  count={count}
                  countLabel={t("device:page.rail.activeLabel", { count })}
                  active={activeCategory === category}
                  onClick={() => setActiveCategory(category)}
                />
              );
            })}
          </Fragment>
        ))}
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
          activeWledIp={activeWledIp}
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
          onStopHue={onStopHueOutput}
          offBehavior={hueOffBehavior}
          onOffBehaviorChange={handleHueOffBehaviorChange}
        />

        <WledCategory isActive={activeCategory === "wled"} />

        <DisplaysCategory
          isActive={activeCategory === "displays"}
          displays={displays}
          capturing={ambilightActive}
          onOpenLedSetup={onOpenLedSetup}
        />
      </div>
    </div>
  );
}
