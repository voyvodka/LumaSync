import { useTranslation } from "react-i18next";

import type { LedStrip } from "@/shared/contracts/strips";
import { RowButton, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

/** Edges a layout lights, for the row's value. */
function edgesOf(strip: LedStrip): number {
  const counts = strip.layout?.counts;
  return counts ? Object.values(counts).filter((count) => count > 0).length : 0;
}

interface StripLayoutRowProps {
  strip: LedStrip;
  /** The page's amber when nothing before it asks for one. */
  primary: boolean;
  onOpen?: () => void;
}

/** How many LEDs the strip has and along how many edges; drawn in LED Setup. */
export function StripLayoutRow({ strip, primary, onOpen }: StripLayoutRowProps) {
  const { t } = useTranslation();
  const needsLayout = strip.layout === undefined;
  return (
    <SettingRow
      label={t("device:strip.row.layout")}
      value={
        needsLayout
          ? t("device:strip.layoutNone")
          : t("device:strip.layoutValue", { count: strip.layout?.totalLeds ?? 0, edges: edgesOf(strip) })
      }
      testId="strip-layout"
      control={
        onOpen ? (
          <RowButton primary={primary && needsLayout} onClick={onOpen} data-testid="strip-layout-open">
            {t(needsLayout ? "device:strip.action.setUp" : "device:strip.action.edit")} ›
          </RowButton>
        ) : null
      }
    />
  );
}
