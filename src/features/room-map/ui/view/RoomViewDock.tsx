import { type KeyboardEvent, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { HUE_IDENTIFY_STATUS } from "@/shared/contracts/hue";
import type { TvAnchorPlacement, UsbStripPlacement } from "@/shared/contracts/roomMap";

import { isBacklightStrip } from "../../model/backlight";
import type { ViewLight } from "../../model/viewLights";
import type { HueIdentify } from "../../state/useHueIdentify";
import type { StripBlink } from "../../state/useStripBlink";
import type { UsbStripStatus } from "../../state/useUsbStripStatus";
import { DockFrame } from "../dock/DockFrame";
import type { UsbStripConnectionStatus } from "../objects/UsbStripInspector";
import type { PaletteHueArea } from "../dock/HueAreaNote";
import { ViewLightCard } from "./ViewLightCard";
import { type LitLamps, ViewLightRow } from "./ViewLightRow";

/** Where focus goes once the page a dock press asked for is up. */
type Pending = "first" | "root" | `chip:${string}`;

export interface RoomViewDockProps {
  lights: readonly ViewLight[];
  hue: PaletteHueArea | null;
  /** The light shown as selected, or null for the row. */
  selected: ViewLight | null;
  strips: readonly UsbStripPlacement[];
  /** The screen, whose backlight strip is how it blinks and reads. */
  tv: TvAnchorPlacement | null;
  stripStatus: UsbStripStatus["stripStatus"];
  hueBridgeStatus: UsbStripConnectionStatus;
  identify: HueIdentify;
  blink: StripBlink;
  canIdentify: boolean;
  /** How bright the room's lights are, 0–1; null while they are off. */
  level: number | null;
  /** Hue is streaming: the bridge will not blink a light, so the card says so before the press. */
  hueStreaming?: boolean;
  lit?: LitLamps | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onEdit: (id: string) => void;
  /** Hands the keys back to the room. */
  onFocusStage: () => void;
}

/**
 * The View face's dock, the same box as the editor's: the room's lights as a row, or one light's
 * card. A press from the keyboard lands on the next page's first control, one from the pointer
 * hands the keys back to the room, and a light picked in the room leaves focus where it was and is
 * announced instead.
 */
export function RoomViewDock({
  lights,
  hue,
  selected,
  strips,
  tv,
  stripStatus,
  hueBridgeStatus,
  identify,
  blink,
  canIdentify,
  level,
  hueStreaming = false,
  lit = null,
  onSelect,
  onBack,
  onEdit,
  onFocusStage,
}: RoomViewDockProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<Pending | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // One page for every card: a pick of another lamp shows its card in place, without a fade.
  const page = selected ? "card" : "lights";
  const target = selected?.id ?? null;

  const land = (asked: Pending) => {
    if (asked === "root") {
      onFocusStage();
      return;
    }
    const live = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("button") ?? []).filter(
      (element) => !element.closest("[inert]"),
    );
    const wanted = asked === "first" ? "[data-dock-first]" : `[data-light-id="${asked.slice("chip:".length)}"]`;
    (live.find((element) => element.matches(wanted)) ?? live[0])?.focus();
  };

  const firstRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `target` is the trigger — only a new light moves focus or speaks
  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const asked = pending.current;
    pending.current = null;
    if (asked !== null) land(asked);
    setAnnouncement(asked === null && selected ? t("roomMap:view.selected", { name: selected.name }) : "");
  }, [target]);

  // A press the selection never answered must not move focus when the next one comes from the room.
  useEffect(() => {
    const forget = (event: Event) => {
      if (!contentRef.current?.contains(event.target as Node)) pending.current = null;
    };
    document.addEventListener("pointerdown", forget, true);
    return () => document.removeEventListener("pointerdown", forget, true);
  }, []);

  const select = (id: string, event: MouseEvent<HTMLButtonElement>) => {
    pending.current = event.detail === 0 ? "first" : "root";
    onSelect(id);
  };
  const back = (keyboard: boolean) => {
    if (!selected) return;
    pending.current = keyboard ? `chip:${selected.id}` : "root";
    onBack();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    if (selected) back(true);
    else onFocusStage();
  };

  const strip =
    selected?.kind === "usb"
      ? strips.find((s) => s.stripId === selected.stripId)
      : selected?.kind === "tv" && tv
        ? strips.find((s) => isBacklightStrip(s, tv))
        : undefined;
  const stripNow = strip ? stripStatus(strip) : undefined;
  const hueFailure = selected && identify.failure?.id === selected.id ? identify.failure.code : null;
  const stripFailure = selected && blink.failure?.id === selected.id ? blink.failure.outcome : null;
  const card = (light: ViewLight) =>
    light.kind === "hue"
      ? {
          connection: hueBridgeStatus,
          canIdentify: canIdentify && !hueStreaming && light.lightIds.length > 0 && !light.ghost,
          identifying: identify.busyId === light.id,
          identifyFailure:
            hueFailure === null
              ? null
              : hueFailure === HUE_IDENTIFY_STATUS.BLOCKED_STREAMING
                ? t("hue:channelMap.identifyBlocked")
                : hueFailure === HUE_IDENTIFY_STATUS.PARTIAL
                  ? t("hue:channelMap.identifyPartial")
                  : t("hue:channelMap.identifyFailed"),
          identifyUnavailable: light.ghost
            ? t("roomMap:inspector.hueGhostShort")
            : light.lightIds.length === 0
              ? t("roomMap:view.identifyUnmatched")
              : !canIdentify
                ? t("roomMap:view.identifyUnavailable")
                : hueStreaming
                  ? t("hue:channelMap.identifyBlocked")
                  : null,
          onIdentify: () => identify.identify(light.id, light.lightIds),
        }
      : {
          connection: stripNow?.status,
          canIdentify: stripNow?.status === "connected",
          identifying: blink.busyId === light.id,
          identifyFailure: stripFailure === null ? null : t(stripFailure === "notSent" ? "device:strip.flash.notSent" : "device:strip.flash.failed"),
          identifyUnavailable: !strip ? t("roomMap:view.blinkNoBacklight") : t("roomMap:view.blinkOffline"),
          onIdentify: () => void blink.blink(light.id, stripNow?.port ?? null),
        };

  return (
    <DockFrame
      contentRef={contentRef}
      label={t("roomMap:view.dock")}
      page={page}
      onKeyDown={onKeyDown}
      testId="room-view-dock"
      glass
      extra={
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      }
    >
      {selected ? (
        <ViewLightCard
          key={selected.id}
          light={selected}
          port={stripNow?.port}
          level={level}
          {...card(selected)}
          onBack={(event) => back(event.detail === 0)}
          onEdit={() => onEdit(selected.id)}
        />
      ) : (
        <ViewLightRow lights={lights} hue={hue} lit={lit} onSelect={select} />
      )}
    </DockFrame>
  );
}
