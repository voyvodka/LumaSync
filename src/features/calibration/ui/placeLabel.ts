import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { LedSegmentKey } from "../model/contracts";
import { placeName, type Corner, type LedRef, type StripShape } from "../model/startPoint";

export const CORNER_KEYS = {
  tl: "calibration:setup.place.tl",
  tr: "calibration:setup.place.tr",
  br: "calibration:setup.place.br",
  bl: "calibration:setup.place.bl",
} as const satisfies Record<Corner, string>;

const EDGE_KEYS = {
  top: "calibration:setup.place.edgeTop",
  right: "calibration:setup.place.edgeRight",
  bottom: "calibration:setup.place.edgeBottom",
  left: "calibration:setup.place.edgeLeft",
} as const satisfies Record<LedSegmentKey, string>;

/** LED #1's place in words: a corner, a side of the stand, or just its edge. */
export function usePlaceLabel() {
  const { t } = useTranslation();
  return useCallback(
    (shape: StripShape, led: LedRef): string => {
      const name = placeName(shape, led);
      switch (name.kind) {
        case "corner":
          return t(CORNER_KEYS[name.corner]);
        case "gapRight":
          return t("calibration:setup.place.gapRight");
        case "gapLeft":
          return t("calibration:setup.place.gapLeft");
        case "edge":
          return t(EDGE_KEYS[name.edge]);
      }
    },
    [t],
  );
}
