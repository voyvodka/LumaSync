import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import type { FurnitureType, HueChannelPlacement, HueZone, RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";
import { resolveFurnitureType } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { ConfirmPopover } from "@/shared/ui/ConfirmPopover/ConfirmPopover";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { PageSwap } from "@/shared/ui/PageSwap/PageSwap";

import { hueChannelName } from "../../model/hueChannelLabel";
import { type InspectorTarget, resolveInspectorTarget } from "../../model/resolveInspectorTarget";
import type { UsbStripConnectionStatus } from "../objects/UsbStripInspector";
import { DockInspector, type InspectorActions, inspectorKey } from "./DockInspector";
import { DOCK_BOTTOM_PX, DOCK_HEIGHT_PX } from "./dockGeometry";
import { IconObjects, IconRoom } from "./dockIcons";
import { DockPalette, type PaletteHueArea } from "./DockPalette";
import { ObjectsPopover } from "./ObjectsPopover";
import styles from "./RoomDock.module.css";
import { RoomPanel, type RoomSettings } from "./RoomPanel";

export interface DockAdd {
  hasTv: boolean;
  onAddFurniture: (type: FurnitureType) => void;
  onAddTv: () => void;
  onSelectTv: () => void;
  onAddStrip: () => void;
  onAddImage: () => void;
  onAddZone: () => void;
}

export interface RoomDockProps {
  /** The map with only the shown area's channels. */
  config: RoomMapConfig;
  /** The shown area's zones. */
  zones: readonly HueZone[];
  selectedId: string | null;
  activeHueZoneId: string | null;
  /** The shown area's channels. */
  channels: readonly HueChannelPlacement[];
  areaChannels: readonly { channelId: number; lightCount: number }[];
  liveChannelIds: ReadonlySet<number> | null;
  stripStatus: (strip: UsbStripPlacement) => { status: UsbStripConnectionStatus; port: string | null };
  hueBridgeStatus: UsbStripConnectionStatus;
  modelChoices: boolean;
  actions: InspectorActions;
  add: DockAdd;
  /** The Hue side of the room, or `null` for a room with no bridge, area, light or zone. */
  hue: PaletteHueArea | null;
  room: RoomSettings;
  onReset: () => void;
  onSelect: (objectId: string) => void;
  onSelectZone: (zoneId: string) => void;
  /** ✕: back one step — an object to its zone, a zone to the palette. */
  onPopSelection: () => void;
  /** Hands the keys back to the editor, whose root routes every shortcut. */
  onFocusEditor: () => void;
}

type Pending = "first" | "root";

/** The selection in a sentence, for the polite announcement a canvas selection makes. */
function describe(target: Exclude<InspectorTarget, { kind: "empty" }>, t: TFunction): string {
  const say = (type: string, name: string) => t("roomMap:dock.selected", { type, name });
  switch (target.kind) {
    case "tv":
      return t("roomMap:objectPanel.tvLabel");
    case "furniture":
      return say(t("roomMap:inspector.typeFurniture"), target.item.label ?? t(`roomMap:furniture.type.${resolveFurnitureType(target.item.type)}`));
    case "usb":
      return say(t("roomMap:inspector.typeUsb"), t("roomMap:objectPanel.ledLabel", { count: String(target.strip.ledCount) }));
    case "hueChannel":
      return say(t("roomMap:inspector.typeHue"), hueChannelName(target.channel, t));
    case "image":
      return say(t("roomMap:inspector.typeImage"), target.layer.label);
    case "hueZone":
      return say(t("roomMap:inspector.typeHueZone"), target.zone.name);
  }
}

/**
 * The editor's one panel, floating over the plan's foot at a height that never changes: a rail
 * (the objects list, the room's settings) and one slot that shows what can be added or, with
 * something selected, its inspector. A selection made from the dock by keyboard lands on the
 * inspector's first field; one made by pointer hands the keys back to the editor; one made on the
 * canvas leaves focus alone and is announced instead.
 */
export function RoomDock(props: RoomDockProps) {
  const { config, zones, selectedId, activeHueZoneId, add, onFocusEditor } = props;
  const { t } = useTranslation();
  const dockRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const objectsRef = useRef<HTMLButtonElement | null>(null);
  const roomRef = useRef<HTMLButtonElement | null>(null);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef<Pending | null>(null);
  const objectsId = useId();
  const roomId = useId();

  const target = resolveInspectorTarget(config, selectedId, activeHueZoneId);
  const key = target.kind === "empty" ? "palette" : inspectorKey(target);

  /** Runs a selection the dock asked for and says where focus goes once its inspector is up. */
  const fromDock = (event: MouseEvent<HTMLButtonElement>, run: () => void) => {
    pending.current = event.detail === 0 ? "first" : "root";
    run();
  };

  // A dock request the selection never answered — an image picker cancelled — must not move focus
  // when the next selection comes from somewhere else.
  useEffect(() => {
    const forget = (event: Event) => {
      if (!dockRef.current?.contains(event.target as Node)) pending.current = null;
    };
    document.addEventListener("pointerdown", forget, true);
    document.addEventListener("focusin", forget, true);
    return () => {
      document.removeEventListener("pointerdown", forget, true);
      document.removeEventListener("focusin", forget, true);
    };
  }, []);

  const firstRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger — a new object of the same kind is a new inspector, and only that moves focus or speaks
  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const asked = pending.current;
    pending.current = null;
    if (asked === "first") {
      // The page leaving is inert while it fades; its fields must not take the focus.
      const live = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-dock-first], button, input") ?? []).filter(
        (element) => !element.closest("[inert]"),
      );
      (live.find((element) => element.hasAttribute("data-dock-first")) ?? live[0])?.focus();
    } else if (asked === "root") {
      onFocusEditor();
    }
    setAnnouncement(asked === null && target.kind !== "empty" ? describe(target, t) : "");
  }, [key]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A popover's keys arrive through the React tree from its portal; they are the popover's.
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    onFocusEditor();
  };

  return (
    <section
      ref={dockRef}
      className={styles.dock}
      style={{ "--room-dock-h": `${DOCK_HEIGHT_PX}px`, "--room-dock-bottom": `${DOCK_BOTTOM_PX}px` } as CSSProperties}
      aria-label={t("roomMap:dock.label")}
      data-room-dock=""
      onKeyDown={onKeyDown}
    >
      <div className={styles.rail}>
        <IconButton
          ref={objectsRef}
          className={cx(styles.railButton, objectsOpen && styles.railOpen)}
          label={t("roomMap:dock.objects")}
          aria-expanded={objectsOpen}
          aria-controls={objectsOpen ? objectsId : undefined}
          icon={<IconObjects />}
          data-testid="dock-objects"
          onClick={() => setObjectsOpen((open) => !open)}
        />
        <IconButton
          ref={roomRef}
          className={cx(styles.railButton, (roomOpen || confirmReset) && styles.railOpen)}
          label={t("roomMap:dock.room")}
          aria-expanded={roomOpen}
          aria-controls={roomOpen ? roomId : undefined}
          icon={<IconRoom />}
          data-testid="dock-room"
          onClick={() => setRoomOpen((open) => !open)}
        />
      </div>
      <span className={styles.separator} aria-hidden="true" />
      <div ref={contentRef} className={styles.content}>
        <PageSwap id={target.kind} way="fade" className={styles.swap}>
          {target.kind === "empty" ? (
            <DockPalette
              hasTv={add.hasTv}
              onAddFurniture={(type, event) => fromDock(event, () => add.onAddFurniture(type))}
              onAddTv={(event) => fromDock(event, add.onAddTv)}
              onSelectTv={(event) => fromDock(event, add.onSelectTv)}
              onAddStrip={(event) => fromDock(event, add.onAddStrip)}
              onAddImage={(event) => fromDock(event, add.onAddImage)}
              onAddZone={(event) => fromDock(event, add.onAddZone)}
              hue={props.hue}
            />
          ) : (
            <DockInspector
              target={target}
              config={config}
              zones={zones}
              channels={props.channels}
              areaChannels={props.areaChannels}
              liveChannelIds={props.liveChannelIds}
              stripStatus={props.stripStatus}
              hueBridgeStatus={props.hueBridgeStatus}
              modelChoices={props.modelChoices}
              actions={props.actions}
              onClose={() => {
                props.onPopSelection();
                // ✕ leaves with its inspector; the keys go back to the editor.
                onFocusEditor();
              }}
            />
          )}
        </PageSwap>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <ObjectsPopover
        open={objectsOpen}
        onClose={() => setObjectsOpen(false)}
        anchorRef={objectsRef}
        id={objectsId}
        config={config}
        zones={zones}
        selectedId={selectedId}
        activeHueZoneId={activeHueZoneId}
        onSelect={(objectId, event) =>
          fromDock(event, () => {
            setObjectsOpen(false);
            props.onSelect(objectId);
          })
        }
        onSelectZone={(zoneId, event) =>
          fromDock(event, () => {
            setObjectsOpen(false);
            props.onSelectZone(zoneId);
          })
        }
      />
      <RoomPanel
        open={roomOpen}
        onClose={() => setRoomOpen(false)}
        anchorRef={roomRef}
        id={roomId}
        settings={props.room}
        onReset={() => {
          setRoomOpen(false);
          setConfirmReset(true);
        }}
      />
      <ConfirmPopover
        open={confirmReset}
        anchorRef={roomRef}
        label={t("roomMap:settings.resetMap")}
        text={t("roomMap:settings.resetMapHint")}
        confirmLabel={t("roomMap:settings.resetConfirm")}
        cancelLabel={t("roomMap:settings.resetCancel")}
        danger
        testId="room-reset-confirm"
        confirmTestId="room-reset-confirm-yes"
        onConfirm={() => {
          setConfirmReset(false);
          props.onReset();
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
