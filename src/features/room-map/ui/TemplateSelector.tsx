import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "@/features/i18n/catalogue";
import type { RoomMapConfig, FurniturePlacement, UsbStripPlacement, TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { RoomPreview } from "./RoomPreview";
import styles from "./TemplateSelector.module.css";

interface TemplateSelectorProps {
  onSelect: (config: RoomMapConfig) => void;
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
    id: "empty",
    nameKey: "roomMap:templates.empty.name",
    descKey: "roomMap:templates.empty.desc",
    config: () => DEFAULT_ROOM_MAP,
  },
];

export function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.page}>
      <div className={styles.column}>
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
