import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { peekLedSetupSource, readLedSetupSource, type LedSetupSource } from "../state/ledSetupSource";
import { displayName } from "./top/displayName";

/**
 * The captured display's name, for a strip's Layout row, when there is more than one to tell apart;
 * `null` with one display, or before the displays are known. It is chosen in LED Setup alone.
 */
export function useCapturedDisplayName(): string | null {
  const { t } = useTranslation();
  const [source, setSource] = useState<LedSetupSource | null>(peekLedSetupSource);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      readLedSetupSource()
        .then((next) => {
          if (!cancelled) setSource(next);
        })
        .catch((error: unknown) => {
          console.warn("[LumaSync] the captured display's name could not be read:", error);
        });
    };
    read();
    const stop = shellStore.onSaved((saved) => {
      if ("selectedDisplayId" in saved) read();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  if (source === null || source.displays.length < 2) return null;
  const display = source.displays.find((candidate) => candidate.id === source.selectedDisplayId) ?? source.displays[0]!;
  return displayName(display, source.displays, t);
}
