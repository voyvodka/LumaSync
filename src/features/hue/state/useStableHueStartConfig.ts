import { useCallback, useState } from "react";

import { isSameHueStartConfig, type HueStartConfig } from "../model/hueStartConfig";

/** Identity changes only when the values do. Storing `toHueStartConfig`'s fresh
 * object on every mode change restarted the reachability probe on a fresh
 * failure budget, so a give-up could never accumulate (#232). */
export function useStableHueStartConfig(): [
  HueStartConfig | null,
  (next: HueStartConfig | null) => void,
] {
  const [config, setConfig] = useState<HueStartConfig | null>(null);

  const setStableConfig = useCallback((next: HueStartConfig | null) => {
    setConfig((prev) => (isSameHueStartConfig(prev, next) ? prev : next));
  }, []);

  return [config, setStableConfig];
}
