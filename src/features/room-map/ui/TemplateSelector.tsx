import { useTranslation } from "react-i18next";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { ROOM_TEMPLATES } from "../model/roomTemplates";
import { RoomPreview } from "./RoomPreview";
import styles from "./TemplateSelector.module.css";

interface TemplateSelectorProps {
  onSelect: (config: RoomMapConfig) => void;
}

export function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.page} data-room-page="">
      <div className={styles.column}>
        <h3 className={styles.title}>{t("roomMap:templates.title")}</h3>
        <p className={styles.subtitle}>{t("roomMap:templates.subtitle")}</p>
        <div className={styles.grid}>
          {ROOM_TEMPLATES.map((tmpl) => {
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
