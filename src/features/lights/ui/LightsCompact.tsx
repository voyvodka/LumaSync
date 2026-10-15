import { memo } from "react";

import styles from "./LightsCompact.module.css";
import { QuickLights } from "./QuickLights";

/** The tray-sized window; the status bar says where the light goes. */
export const LightsCompact = memo(function LightsCompact() {
  return (
    <div className={styles.compact} data-lights data-testid="compact-layout">
      <QuickLights />
    </div>
  );
});
