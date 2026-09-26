import { useTranslation } from "react-i18next";

import type { LedChipType } from "@/shared/contracts/device";
import { maxTotal, minTotal, sumCounts, type DisplayAspect, type LayoutDraft } from "../../model/ledLayout";
import { estimateStripPower } from "../../model/powerEstimate";
import { NumberField } from "./NumberField";

interface TotalControlProps {
  draft: LayoutDraft;
  display: DisplayAspect;
  /** What a bound WLED panel reports, offered while editing when it differs. */
  knownTotal: number | null;
  chipType: LedChipType;
  /** A changed total, shared out over the lit edges. */
  onDistribute: (total: number) => void;
  /** A valid total being typed, for the canvas to preview; null when there is none. */
  onPreview: (total: number | null) => void;
}

/** The strip's total LEDs: typing a new one shares it out over the lit edges; the canvas previews it first. */
export function TotalControl({ draft, display, knownTotal, chipType, onDistribute, onPreview }: TotalControlProps) {
  const { t, i18n } = useTranslation();
  const total = sumCounts(draft.counts);
  const floor = minTotal(draft);
  const ceiling = maxTotal(draft, display);
  const lengthPower = (n: number) =>
    t("calibration:setup.lengthPower", {
      meters: new Intl.NumberFormat(i18n?.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n / 60),
      watts: estimateStripPower(n, chipType).watts,
    });

  return (
    <NumberField
      value={total}
      min={floor}
      max={ceiling}
      unit="LED"
      labels={{
        edit: t("calibration:setup.editTotal", { n: total }),
        field: t("calibration:setup.totalField"),
        apply: t("calibration:setup.applyTotal"),
        range: t("calibration:setup.range", { min: floor, max: ceiling }),
      }}
      describe={lengthPower}
      suggestion={knownTotal === null ? null : { value: knownTotal, label: t("calibration:setup.wledTotal", { n: knownTotal }) }}
      onCommit={onDistribute}
      onPreview={onPreview}
    />
  );
}
