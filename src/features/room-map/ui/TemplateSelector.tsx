import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "@/features/i18n/catalogue";
import type {
  FurnitureType,
  FurnitureVariant,
  RoomMapConfig,
  FurniturePlacement,
  RoomStructure,
  UsbStripPlacement,
  TvAnchorPlacement,
} from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { STRUCTURE_NAME_KEYS } from "../model/roomStructures";
import { RoomPreview } from "./RoomPreview";
import styles from "./TemplateSelector.module.css";

interface TemplateSelectorProps {
  onSelect: (config: RoomMapConfig) => void;
  /** Opened over a room from its settings: back to it, unchanged. */
  onBack?: () => void;
}

interface Template {
  id: string;
  nameKey: TranslationKey;
  descKey: TranslationKey;
  config: (t: TFunction) => RoomMapConfig;
}

function makeTemplate(
  overrides: Partial<RoomMapConfig> & { tvAnchor?: TvAnchorPlacement; furniture?: FurniturePlacement[]; usbStrips?: UsbStripPlacement[] },
): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

/** A showroom piece, named by its model so each one can be told apart in the list. */
function shown(t: TFunction, type: FurnitureType, variant: FurnitureVariant | null, x: number, y: number, width: number, height: number): FurniturePlacement {
  return {
    id: `show-${type}-${variant ?? "plain"}`,
    type,
    x,
    y,
    width,
    height,
    rotation: 0,
    label: variant ? t(`roomMap:furniture.variant.${variant}`) : t(`roomMap:furniture.type.${type}`),
    ...(variant ? { variant } : {}),
  };
}

/** Every structure the room can be built with, on the walls and in the free end past the furniture. */
function showroomStructures(t: TFunction): RoomStructure[] {
  const label = (kind: RoomStructure["kind"]) => t(STRUCTURE_NAME_KEYS[kind]);
  return [
    { id: "show-beam", kind: "beam", label: label("beam"), x1: 10, y1: 0, x2: 10, y2: 8, width: 0.25, dropMeters: 0.3 },
    { id: "show-column-square", kind: "column", label: label("column"), x: 10.9, y: 4.6, width: 0.4, depth: 0.4 },
    { id: "show-column-round", kind: "column", label: label("column"), x: 11.6, y: 6.6, width: 0.36, depth: 0.36, shape: "round" },
    { id: "show-window-left", kind: "window", label: label("window"), x: 0, y: 4.0, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 },
    { id: "show-window-back", kind: "window", label: label("window"), x: 8.9, y: 8, width: 1.6, sillMeters: 0.8, heightMeters: 1.3 },
    { id: "show-door-back", kind: "door", label: label("door"), x: 11.4, y: 8, width: 0.9, heightMeters: 2.05, hinge: "right", swing: "in" },
    { id: "show-door-right", kind: "door", label: label("door"), x: 12.5, y: 1.6, width: 0.9, heightMeters: 2.05, hinge: "left", swing: "out" },
    { id: "show-niche", kind: "niche", label: label("niche"), x: 12.5, y: 4.4, width: 0.8, bottomMeters: 0.5, heightMeters: 1.1, depth: 0.25 },
    { id: "show-light-living", kind: "light", label: label("light"), x: 4.1, y: 2.2, fixture: "ceiling" },
    { id: "show-light-dining", kind: "light", label: label("light"), x: 1.1, y: 5.05, fixture: "pendant" },
    { id: "show-light-kitchen-1", kind: "light", label: label("light"), x: 0.7, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-kitchen-2", kind: "light", label: label("light"), x: 1.4, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-kitchen-3", kind: "light", label: label("light"), x: 2.1, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-bulb", kind: "light", label: label("light"), x: 11.4, y: 3.0, fixture: "bulb", kelvin: 2200 },
  ];
}

/** Every type and every model it takes, in rows facing the TV wall like a shop floor, and every
 *  structure past them. */
function showroom(t: TFunction): RoomMapConfig {
  const s = (type: FurnitureType, variant: FurnitureVariant | null, x: number, y: number, w: number, h: number) => shown(t, type, variant, x, y, w, h);
  return makeTemplate({
    dimensions: { widthMeters: 12.5, depthMeters: 8, heightMeters: 2.7 },
    structures: showroomStructures(t),
    tvAnchor: { x: 3.6, y: 0.12, width: 1.4, height: 0.08 },
    usbStrips: [
      { stripId: "usb-tv", startX: 3.7, startY: 0.1, endX: 4.9, endY: 0.1, ledCount: 60 },
      { stripId: "usb-wall", startX: 12.49, startY: 2.4, endX: 12.49, endY: 3.9, ledCount: 90, mountHeightMeters: 1.2 },
    ],
    // Rugs first, so the plan draws them under what stands near them.
    furniture: [
      s("rug", "rectangle", 5.0, 4.6, 2.0, 1.4),
      s("rug", "round", 7.3, 4.6, 1.4, 1.4),
      s("storage", "bookshelf", 0.2, 0, 1.0, 0.32),
      s("storage", "sideboard", 1.4, 0, 1.6, 0.45),
      s("storage", "tvUnit", 3.3, 0, 2.0, 0.45),
      s("storage", "dresser", 5.6, 0, 1.0, 0.5),
      s("storage", "wardrobe", 6.9, 0, 2.0, 0.6),
      s("storage", "nightstand", 9.2, 0, 0.45, 0.4),
      s("sofa", "straight", 0.3, 1.2, 2.1, 0.9),
      s("sofa", "cornerLeft", 2.8, 1.2, 2.6, 1.6),
      s("sofa", "cornerRight", 5.8, 1.2, 2.6, 1.6),
      s("chair", "dining", 0.3, 3.3, 0.5, 0.5),
      s("chair", "office", 1.1, 3.3, 0.6, 0.6),
      s("chair", "armchair", 2.0, 3.3, 0.85, 0.85),
      s("chair", "bench", 3.2, 3.3, 1.2, 0.4),
      s("chair", "stool", 4.7, 3.3, 0.4, 0.4),
      s("chair", "beanbag", 5.4, 3.3, 0.9, 0.9),
      s("table", "desk", 6.6, 3.3, 1.4, 0.7),
      s("table", "coffee", 8.3, 3.3, 1.1, 0.6),
      s("table", "dining", 0.3, 4.6, 1.6, 0.9),
      s("table", "side", 2.2, 4.6, 0.5, 0.5),
      s("bed", null, 3.0, 4.6, 1.6, 2.05),
      s("plant", "topiary", 7.6, 6.2, 0.5, 0.5),
      s("plant", "leafy", 8.3, 6.2, 0.6, 0.6),
      s("plant", "palm", 9.1, 6.2, 0.7, 0.7),
      s("kitchen", "counter", 0.2, 7.38, 2.4, 0.62),
      s("kitchen", "fridge", 2.7, 7.32, 0.7, 0.68),
      s("kitchen", "island", 5.0, 6.6, 1.8, 0.9),
      s("other", null, 7.2, 7.2, 0.6, 0.6),
    ],
  });
}

const TEMPLATES: Template[] = [
  {
    id: "tv55",
    nameKey: "roomMap:templates.tv55.name",
    descKey: "roomMap:templates.tv55.desc",
    config: (t) => makeTemplate({
      tvAnchor: { x: 1.75, y: 0.2, width: 1.2, height: 0.08 },
      usbStrips: [
        { stripId: "usb-tv", startX: 1.85, startY: 0.15, endX: 2.85, endY: 0.15, ledCount: 60 },
      ],
      furniture: [
        { id: "sofa-1", type: "sofa", x: 1.5, y: 2.8, width: 2.0, height: 0.8, label: t("roomMap:furniture.templateLabel.sofa") },
      ],
    }),
  },
  {
    id: "ldesk",
    nameKey: "roomMap:templates.ldesk.name",
    descKey: "roomMap:templates.ldesk.desc",
    config: (t) => makeTemplate({
      dimensions: { widthMeters: 3, depthMeters: 3, heightMeters: 2.5 },
      tvAnchor: { x: 0.6, y: 0.1, width: 0.7, height: 0.05 },
      usbStrips: [
        { stripId: "usb-desk", startX: 0.65, startY: 0.08, endX: 1.25, endY: 0.08, ledCount: 30 },
      ],
      furniture: [
        { id: "desk-main", type: "table", x: 0.3, y: 0.0, width: 1.4, height: 0.7, label: t("roomMap:furniture.templateLabel.desk") },
        { id: "desk-side", type: "table", x: 0.0, y: 0.0, width: 0.3, height: 1.2, label: t("roomMap:furniture.templateLabel.side") },
        { id: "chair-1", type: "chair", x: 0.7, y: 0.9, width: 0.5, height: 0.5, label: t("roomMap:furniture.templateLabel.chair") },
      ],
    }),
  },
  {
    id: "fullroom",
    nameKey: "roomMap:templates.fullroom.name",
    descKey: "roomMap:templates.fullroom.desc",
    config: (t) => makeTemplate({
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tvAnchor: { x: 1.75, y: 0.2, width: 1.5, height: 0.08 },
      usbStrips: [
        { stripId: "usb-tv", startX: 1.85, startY: 0.15, endX: 3.15, endY: 0.15, ledCount: 90 },
      ],
      // The rug first, so the plan draws it under the pieces standing on it.
      furniture: [
        { id: "rug-1", type: "rug", x: 1.3, y: 1.3, width: 2.4, height: 1.9, label: t("roomMap:furniture.type.rug") },
        { id: "sofa-1", type: "sofa", x: 1.5, y: 2.5, width: 2.0, height: 0.9, label: t("roomMap:furniture.templateLabel.sofa") },
        { id: "table-1", type: "table", x: 2.0, y: 1.6, width: 1.0, height: 0.6, label: t("roomMap:furniture.templateLabel.coffeeTable") },
        { id: "chair-1", type: "chair", x: 0.3, y: 2.5, width: 0.7, height: 0.7, label: t("roomMap:furniture.templateLabel.armchair") },
        { id: "plant-1", type: "plant", x: 4.3, y: 0.25, width: 0.5, height: 0.5, label: t("roomMap:furniture.type.plant") },
      ],
    }),
  },
  {
    id: "showroom",
    nameKey: "roomMap:templates.showroom.name",
    descKey: "roomMap:templates.showroom.desc",
    config: showroom,
  },
  {
    id: "empty",
    nameKey: "roomMap:templates.empty.name",
    descKey: "roomMap:templates.empty.desc",
    config: () => DEFAULT_ROOM_MAP,
  },
];

export function TemplateSelector({ onSelect, onBack }: TemplateSelectorProps) {
  const { t } = useTranslation();
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => backRef.current?.focus(), []);

  return (
    <div
      className={styles.page}
      data-room-page=""
      onKeyDown={(event) => {
        if (onBack && event.key === "Escape") onBack();
      }}
    >
      <div className={styles.column}>
        {onBack && (
          <button ref={backRef} type="button" className={styles.back} onClick={onBack}>
            <span aria-hidden="true">‹</span> {t("roomMap:templates.back")}
          </button>
        )}
        <h3 className={styles.title}>{t("roomMap:templates.title")}</h3>
        <p className={styles.subtitle}>{t("roomMap:templates.subtitle")}</p>
        <div className={styles.grid}>
          {TEMPLATES.map((tmpl) => {
            const config = tmpl.config(t);
            return (
              <button
                key={tmpl.id}
                type="button"
                aria-label={t(tmpl.nameKey)}
                className={styles.card}
                onClick={() => onSelect(config)}
              >
                <span className={styles.preview}>
                  <RoomPreview config={config} />
                </span>
                <span className={styles.name}>{t(tmpl.nameKey)}</span>
                <span className={styles.desc}>{t(tmpl.descKey)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
