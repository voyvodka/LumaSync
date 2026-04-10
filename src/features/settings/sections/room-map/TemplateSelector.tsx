import { useTranslation } from "react-i18next";
import type { RoomMapConfig, FurniturePlacement, UsbStripPlacement, TvAnchorPlacement } from "../../../../shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "../../../../shared/contracts/roomMap";

interface TemplateSelectorProps {
  onSelect: (config: RoomMapConfig) => void;
}

interface Template {
  id: string;
  nameKey: string;
  descKey: string;
  icon: string;
  config: (t: (key: string) => string) => RoomMapConfig;
}

function makeTemplate(
  overrides: Partial<RoomMapConfig> & { tvAnchor?: TvAnchorPlacement; furniture?: FurniturePlacement[]; usbStrips?: UsbStripPlacement[] },
): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

const TEMPLATES: Template[] = [
  {
    id: "tv55",
    nameKey: "roomMap.templates.tv55.name",
    descKey: "roomMap.templates.tv55.desc",
    icon: "📺",
    config: (t) => makeTemplate({
      tvAnchor: { x: 1.75, y: 0.2, width: 1.2, height: 0.08 },
      usbStrips: [
        { stripId: "usb-tv", startX: 1.85, startY: 0.15, endX: 2.85, endY: 0.15, ledCount: 60 },
      ],
      furniture: [
        { id: "sofa-1", type: "sofa", x: 1.5, y: 2.8, width: 2.0, height: 0.8, label: t("roomMap.furniture.templateLabel.sofa") },
      ],
    }),
  },
  {
    id: "ldesk",
    nameKey: "roomMap.templates.ldesk.name",
    descKey: "roomMap.templates.ldesk.desc",
    icon: "🖥",
    config: (t) => makeTemplate({
      dimensions: { widthMeters: 3, depthMeters: 3, heightMeters: 2.5 },
      tvAnchor: { x: 0.6, y: 0.1, width: 0.7, height: 0.05 },
      usbStrips: [
        { stripId: "usb-desk", startX: 0.65, startY: 0.08, endX: 1.25, endY: 0.08, ledCount: 30 },
      ],
      furniture: [
        { id: "desk-main", type: "table", x: 0.3, y: 0.0, width: 1.4, height: 0.7, label: t("roomMap.furniture.templateLabel.desk") },
        { id: "desk-side", type: "table", x: 0.0, y: 0.0, width: 0.3, height: 1.2, label: t("roomMap.furniture.templateLabel.side") },
        { id: "chair-1", type: "chair", x: 0.7, y: 0.9, width: 0.5, height: 0.5, label: t("roomMap.furniture.templateLabel.chair") },
      ],
    }),
  },
  {
    id: "fullroom",
    nameKey: "roomMap.templates.fullroom.name",
    descKey: "roomMap.templates.fullroom.desc",
    icon: "🏠",
    config: (t) => makeTemplate({
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tvAnchor: { x: 1.75, y: 0.2, width: 1.5, height: 0.08 },
      usbStrips: [
        { stripId: "usb-tv", startX: 1.85, startY: 0.15, endX: 3.15, endY: 0.15, ledCount: 90 },
      ],
      furniture: [
        { id: "sofa-1", type: "sofa", x: 1.5, y: 2.5, width: 2.0, height: 0.9, label: t("roomMap.furniture.templateLabel.sofa") },
        { id: "table-1", type: "table", x: 2.0, y: 1.6, width: 1.0, height: 0.6, label: t("roomMap.furniture.templateLabel.coffeeTable") },
        { id: "chair-1", type: "chair", x: 0.3, y: 2.5, width: 0.7, height: 0.7, label: t("roomMap.furniture.templateLabel.armchair") },
      ],
    }),
  },
  {
    id: "empty",
    nameKey: "roomMap.templates.empty.name",
    descKey: "roomMap.templates.empty.desc",
    icon: "✏️",
    config: () => DEFAULT_ROOM_MAP,
  },
];

export function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const { t } = useTranslation("common");

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-[480px] px-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-200 text-center mb-1">
          {t("roomMap.templates.title")}
        </h3>
        <p className="text-[11px] text-slate-500 dark:text-zinc-400 text-center mb-4">
          {t("roomMap.templates.subtitle")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {TEMPLATES.map((tmpl) => (
            <button
              key={tmpl.id}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-200/70 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-3 hover:bg-slate-50 dark:hover:bg-zinc-800 hover:border-cyan-400/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
              onClick={() => onSelect(tmpl.config(t))}
            >
              <span className="text-2xl">{tmpl.icon}</span>
              <span className="text-[11px] font-semibold text-slate-700 dark:text-zinc-200">
                {t(tmpl.nameKey)}
              </span>
              <span className="text-[9px] text-slate-400 dark:text-zinc-500 text-center leading-tight">
                {t(tmpl.descKey)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
