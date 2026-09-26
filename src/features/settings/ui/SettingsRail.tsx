import { useTranslation } from "react-i18next";

import { SETTINGS_PAGE_IDS, settingsPage, type SettingsPageId } from "./settingsRegistry";
import styles from "./SettingsRail.module.css";

interface SettingsRailProps {
  active: SettingsPageId;
  onSelect: (page: SettingsPageId) => void;
}

/**
 * The pages, one row each. A `<nav>` with `aria-current`, not a tablist: a tablist would promise
 * arrow keys the rail does not implement. The selection is one tint that slides to the page.
 */
export function SettingsRail({ active, onSelect }: SettingsRailProps) {
  const { t } = useTranslation();
  const index = SETTINGS_PAGE_IDS.indexOf(active);
  return (
    <nav className={styles.rail} aria-label={t("settings:title")}>
      <div className={styles.list}>
        <span className={styles.tint} style={{ transform: `translateY(${index * 100}%)` }} aria-hidden="true" />
        {SETTINGS_PAGE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={styles.item}
            aria-current={id === active ? "page" : undefined}
            onClick={() => onSelect(id)}
            data-testid={`settings-page-${id}`}
          >
            {t(settingsPage(id).labelKey)}
          </button>
        ))}
      </div>
    </nav>
  );
}
