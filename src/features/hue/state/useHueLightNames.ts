import { useCallback, useEffect, useMemo, useState } from "react";

import {
  HUE_IDENTIFY_STATUS,
  HUE_LIGHT_NAMES_STATUS,
  type HueIdentifyStatus,
  type HueLightName,
} from "@/shared/contracts/hue";
import { parseCommandError } from "@/shared/contracts/status";

import {
  getHueLightNames,
  identifyHueLights,
  type HueAreaChannelInfo,
  type HueBridgeSummary,
  type HuePairingCredentials,
} from "../hueOnboardingApi";

import {
  __resetHueLightCache,
  cachedHueLights,
  forgetHueLights,
  hueLightCacheKey,
  storeHueLights,
} from "./hueLightCache";

/** Test seam — the cache is module state. */
export function __resetHueLightNameCache(): void {
  __resetHueLightCache();
}

const namesOf = (lights: readonly HueLightName[]): Readonly<Record<string, string>> =>
  Object.fromEntries(lights.map((light) => [light.id, light.name]));

const NO_NAMES: Readonly<Record<string, string>> = {};

export interface UseHueLightNamesResult {
  /** Light id → the name the Hue app shows. A light missing here is unnamed
   *  or not read yet; show its count instead, never its id. */
  lightNames: Readonly<Record<string, string>>;
  /** Drop this area's cached names and read them again. */
  reloadLightNames: () => void;
  /** Blink these lights once. Never throws; check `code`. */
  identifyLights: (lightIds: string[]) => Promise<HueIdentifyStatus>;
}

export function useHueLightNames(
  bridge: HueBridgeSummary | null,
  credentials: HuePairingCredentials | null,
  channels: readonly HueAreaChannelInfo[],
): UseHueLightNamesResult {
  const lightIds = useMemo(
    () => [...new Set(channels.flatMap((channel) => channel.lightIds))].sort(),
    [channels],
  );
  const key = bridge && credentials && lightIds.length > 0 ? hueLightCacheKey(bridge.ip, lightIds) : null;
  const [names, setNames] = useState<{ key: string | null; value: Readonly<Record<string, string>> }>({
    key: null,
    value: NO_NAMES,
  });
  const [reloadToken, setReloadToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for bridge, credentials and ids; reloadToken re-runs the read
  useEffect(() => {
    if (key === null || !bridge || !credentials) return;
    const cached = cachedHueLights(key);
    if (cached) {
      setNames({ key, value: namesOf(cached) });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await getHueLightNames(bridge.ip, credentials.username, lightIds);
        if (cancelled) return;
        if (response.status.code !== HUE_LIGHT_NAMES_STATUS.OK) {
          console.warn(
            `[LumaSync] Hue light names not read (${response.status.code}): ${response.status.details ?? response.status.message}`,
          );
          return;
        }
        storeHueLights(key, response.lights);
        setNames({ key, value: namesOf(response.lights) });
      } catch (error) {
        if (!cancelled) {
          console.warn(`[LumaSync] Hue light names invoke rejected: ${parseCommandError(error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, reloadToken]);

  const reloadLightNames = useCallback(() => {
    if (key !== null) forgetHueLights(key);
    setReloadToken((n) => n + 1);
  }, [key]);

  const identifyLights = useCallback(
    async (ids: string[]): Promise<HueIdentifyStatus> => {
      if (!bridge || !credentials) {
        return { code: HUE_IDENTIFY_STATUS.FAILED, message: "No paired bridge.", details: null };
      }
      try {
        return await identifyHueLights(bridge.ip, credentials.username, ids);
      } catch (error) {
        return {
          code: HUE_IDENTIFY_STATUS.FAILED,
          message: "No Hue light was identified.",
          details: parseCommandError(error).message,
        };
      }
    },
    [bridge, credentials],
  );

  return {
    lightNames: names.key === key ? names.value : NO_NAMES,
    reloadLightNames,
    identifyLights,
  };
}
