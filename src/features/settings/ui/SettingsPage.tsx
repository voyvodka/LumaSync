import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useSessionState } from "@/shared/lib/useSessionState";
import { Rail } from "@/shared/ui/Rail/Rail";

import { PreferenceChoice } from "./rows/PreferenceChoice";
import { PreferenceSwitch } from "./rows/PreferenceSwitch";
import type { SettingsEnv } from "./settingsEnv";
import { SETTINGS_PAGE_IDS, settingRow, settingsPage, type SettingRowId, type SettingsPageId } from "./settingsRegistry";
import styles from "./SettingsPage.module.css";

function Row({ id, env }: { id: SettingRowId; env: SettingsEnv }) {
  const def = settingRow(id);
  if (def.kind === "switch") {
    const { kind: _kind, ...rest } = def;
    return <PreferenceSwitch {...rest} />;
  }
  if (def.kind === "choice") {
    const { kind: _kind, ...rest } = def;
    return <PreferenceChoice {...rest} />;
  }
  const { Row: Custom } = def;
  return <Custom {...env} />;
}

/** Settings: the pages on a rail, the chosen one's rows beside it. */
export function SettingsPage(env: SettingsEnv) {
  const { t } = useTranslation();
  // Back on the page it was left on after a visit elsewhere; a restart opens General.
  const [page, setPage] = useSessionState<SettingsPageId>("settings.page", "general");
  const headingId = useId();
  const { labelKey, rows } = settingsPage(page);
  return (
    <div className={styles.page}>
      <Rail
        label={t("settings:title")}
        items={SETTINGS_PAGE_IDS.map((id) => ({ id, label: t(settingsPage(id).labelKey), testId: `settings-page-${id}` }))}
        active={page}
        onSelect={setPage}
      />
      <div className={styles.scroll}>
        {/* Keyed by page: the new page's rows arrive with a small rise. */}
        <section key={page} className={styles.content} aria-labelledby={headingId}>
          <h1 id={headingId} className={styles.title}>
            {t(labelKey)}
          </h1>
          {rows.map((id) => (
            <Row key={id} id={id} env={env} />
          ))}
        </section>
      </div>
    </div>
  );
}
