import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { usePresence } from "@/shared/lib/usePresence";
import { useUpdaterActions, useUpdaterState, type UpdaterSnapshot } from "./UpdaterProvider";
import styles from "./UpdateStatusItem.module.css";

// A primitive, so a download's progress ticks never re-render it.
const selectOffered = (snapshot: UpdaterSnapshot) =>
  snapshot.state.status === "available" && !snapshot.isModalOpen ? snapshot.state.update.version : null;

/**
 * An update that is ready but not on screen — found in the background, or put off with "Later".
 * A quiet item in the status bar instead of a prompt over the window; pressing it opens the prompt.
 */
export function UpdateStatusItem({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const version = useUpdaterState(selectOffered);
  const { showUpdate } = useUpdaterActions();
  // Kept while it fades out, so it leaves saying what it said.
  const lastRef = useRef(version);
  if (version !== null) lastRef.current = version;
  const { mounted, leaving } = usePresence(version !== null, 300);
  if (!mounted || lastRef.current === null) return null;
  const shown = lastRef.current;
  return (
    <button
      type="button"
      className={leaving ? `${styles.item} ${styles.leaving}` : styles.item}
      onClick={showUpdate}
      aria-label={t("updater:statusItem.aria", { version: shown })}
      title={t("updater:statusItem.aria", { version: shown })}
      data-testid="update-status-item"
    >
      <span aria-hidden="true">●</span>
      {compact ? t("updater:statusItem.short") : t("updater:statusItem.label", { version: shown })}
    </button>
  );
}
