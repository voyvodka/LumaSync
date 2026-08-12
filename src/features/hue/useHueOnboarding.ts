import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_CREDENTIAL_STATUS,
  HUE_ONBOARDING_STEP,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
  type HueRuntimeTarget,
  type HueRuntimeTargetTelemetryRow,
} from "@/shared/contracts/hue";
import type { ShellState } from "@/shared/contracts/shell";
import { restartHue, startHue } from "../mode/modeApi";
import { shellStore } from "../persistence/shellStore";
import { readHueStreamReadiness, readHueStreamStatus } from "./hueReadCache";
import {
  applyAreaReadinessSnapshot,
  flattenAreaGroups,
  normalizeAreas,
} from "./model/areaGrouping";
import { dedupeBridges, normalizeIpValue, resolveManualIpError } from "./model/bridgeIdentity";
import { deriveStep, toPersistedStep, toStepFromPersisted } from "./model/onboardingStep";
import { HUE_ONBOARDING_TRANSPORT_CODES as CODE, toErrorDetails } from "./model/onboardingStatusCodes";
import {
  DEFAULT_STATE,
  type HueAreaReadiness,
  type HueOnboardingState,
  type HueStep,
  type UseHueOnboardingResult,
} from "./model/onboardingTypes";
import {
  READINESS_BACKGROUND_REFRESH_MS,
  READINESS_BLOCKED_REFRESH_MS,
  READINESS_STALE_MS,
  RUNTIME_POLL_INTERVAL_MS,
  RUNTIME_POLL_MIN_INTERVAL_MS,
  STREAMING_RUNTIME_STATES,
} from "./model/pollingCadence";
import { deriveRuntimeTargets } from "./model/runtimeTargets";
import {
  checkHueStreamReadiness,
  discoverHueBridges,
  getHueAreaChannels,
  listHueEntertainmentAreas,
  migrateHueCredentials,
  pairHueBridge,
  type HueAreaChannelInfo,
  type HuePairingCredentials,
  validateHueCredentials,
  verifyHueBridgeIp,
} from "./hueOnboardingApi";

export { deriveRuntimeTargets };
export type {
  HueAreaGroup,
  HueAreaReadiness,
  HueAreaRow,
  UseHueOnboardingResult,
} from "./model/onboardingTypes";

async function persistResumeState(step: HueStep): Promise<void> {
  await shellStore.save({ hueOnboardingStep: toPersistedStep(step) });
}

/** One-shot cleanup for pre-keychain installs; deliberately not a store
 * migration — see docs/architecture/hue.md. */
async function migrateStoredCredentialsToKeychain(storedState: ShellState): Promise<void> {
  if (storedState.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN) {
    return;
  }

  const username = storedState.hueAppKey;
  const clientKey = storedState.hueClientKey;
  if (!username || !clientKey) {
    return;
  }

  try {
    const response = await migrateHueCredentials(username, clientKey);
    if (response.backend !== HUE_CREDENTIAL_BACKENDS.KEYCHAIN) {
      return;
    }

    await shellStore.save({
      hueClientKey: undefined,
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    });
  } catch (error) {
    console.warn("[LumaSync] Hue credential keychain migration failed", error);
  }
}

export function useHueOnboarding(): UseHueOnboardingResult {
  const [state, setState] = useState<HueOnboardingState>(DEFAULT_STATE);
  const [readinessById, setReadinessById] = useState<Map<string, HueAreaReadiness>>(new Map());
  const [readinessCheckedAtById, setReadinessCheckedAtById] = useState<Map<string, number>>(new Map());
  const [runtimeStatus, setRuntimeStatus] = useState<HueRuntimeStatus | null>(null);
  /** Survives the runtime-loop effect re-running on every state transition. */
  const lastRuntimePollAtRef = useRef(0);
  const [runtimeTargets, setRuntimeTargets] = useState<HueRuntimeTargetTelemetryRow[]>([]);
  const [isRuntimeMutating, setIsRuntimeMutating] = useState(false);
  const [areaChannels, setAreaChannels] = useState<HueAreaChannelInfo[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [channelRegionOverrides, setChannelRegionOverrides] = useState<Record<number, string>>({});

  const selectedBridge = useMemo(
    () => state.bridges.find((bridge) => bridge.id === state.selectedBridgeId) ?? null,
    [state.bridges, state.selectedBridgeId],
  );

  const selectedArea = useMemo(() => {
    return flattenAreaGroups(state.areaGroups).find((area) => area.id === state.selectedAreaId) ?? null;
  }, [state.areaGroups, state.selectedAreaId]);

  const isReadinessStale = useMemo(() => {
    if (!selectedArea?.readiness?.ready || !state.selectedAreaId) {
      return false;
    }

    const checkedAt = readinessCheckedAtById.get(state.selectedAreaId);
    if (!checkedAt) {
      return true;
    }

    return Date.now() - checkedAt > READINESS_STALE_MS;
  }, [readinessCheckedAtById, selectedArea?.readiness?.ready, state.selectedAreaId]);

  const canStartHue = useMemo(() => {
    return Boolean(
      selectedBridge &&
        state.credentials &&
        state.credentialState === HUE_CREDENTIAL_STATUS.VALID &&
        selectedArea &&
        selectedArea.readiness?.ready &&
        !isReadinessStale &&
        !state.isValidatingCredential,
    );
  }, [selectedBridge, selectedArea, state.credentials, state.credentialState, isReadinessStale, state.isValidatingCredential]);

  const patchState = useCallback((updater: (prev: HueOnboardingState) => HueOnboardingState) => {
    setState((prev) => {
      const next = updater(prev);
      const step = deriveStep(next);
      if (next.step !== step) {
        void persistResumeState(step);
      }
      return {
        ...next,
        step,
      };
    });
  }, []);

  // Load channels whenever the selected area or credentials change.
  useEffect(() => {
    if (!selectedBridge || !state.credentials || !state.selectedAreaId) {
      setAreaChannels([]);
      return;
    }

    let cancelled = false;
    const areaId = state.selectedAreaId;
    const { ip } = selectedBridge;
    const { username } = state.credentials;

    setIsLoadingChannels(true);
    void getHueAreaChannels(ip, username, areaId)
      .then((channels) => {
        if (!cancelled) {
          setAreaChannels(channels);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAreaChannels([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingChannels(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBridge, state.credentials, state.selectedAreaId]);

  // Load channel overrides for the selected area from the store.
  useEffect(() => {
    if (!state.selectedAreaId) {
      setChannelRegionOverrides({});
      return;
    }

    const areaId = state.selectedAreaId;
    void shellStore.load().then((stored) => {
      const overrides = stored.hueChannelRegionOverrides?.[areaId] ?? {};
      setChannelRegionOverrides(overrides);
    });
  }, [state.selectedAreaId]);

  const setChannelRegion = useCallback(
    (channelIndex: number, region: string | null) => {
      if (!state.selectedAreaId) return;

      const areaId = state.selectedAreaId;
      setChannelRegionOverrides((prev) => {
        const next = { ...prev };
        if (region === null) {
          delete next[channelIndex];
        } else {
          next[channelIndex] = region;
        }

        void shellStore.load().then((stored) => {
          const allOverrides = { ...(stored.hueChannelRegionOverrides ?? {}) };
          if (Object.keys(next).length === 0) {
            delete allOverrides[areaId];
          } else {
            allOverrides[areaId] = next;
          }
          void shellStore.save({ hueChannelRegionOverrides: allOverrides });
        });

        return next;
      });
    },
    [state.selectedAreaId],
  );

  const applyReadinessResult = useCallback(
    (
      areaId: string,
      response: Awaited<ReturnType<typeof checkHueStreamReadiness>>,
      options?: {
        publishStatus?: boolean;
        persistReadyStep?: boolean;
      },
    ) => {
      const readiness: HueAreaReadiness = {
        ready: response.readiness.ready,
        reasons: response.readiness.reasons,
        code: response.status.code,
        message: response.status.message,
        details: response.status.details,
      };

      setReadinessById((prev) => {
        const next = new Map(prev);
        next.set(areaId, readiness);
        return next;
      });

      setReadinessCheckedAtById((prev) => {
        const next = new Map(prev);
        next.set(areaId, Date.now());
        return next;
      });

      patchState((prev) => {
        const areaGroups = applyAreaReadinessSnapshot(prev.areaGroups, areaId, readiness);

        return {
          ...prev,
          areaGroups,
          status: options?.publishStatus === false ? prev.status : response.status,
        };
      });

      if (response.readiness.ready && options?.persistReadyStep !== false) {
        void shellStore.save({
          hueOnboardingStep: HUE_ONBOARDING_STEP.READY,
        });
      }
    },
    [patchState],
  );

  // Credentials come in as an argument because `pair()` calls this before its
  // captured `state.credentials` has caught up — still null on a first pairing,
  // still the superseded key on a re-pair.
  const refreshAreasWith = useCallback(async (credentials: HuePairingCredentials | null) => {
    if (!selectedBridge || !credentials) {
      return;
    }

    patchState((prev) => ({
      ...prev,
      isLoadingAreas: true,
    }));

    try {
      const response = await listHueEntertainmentAreas(selectedBridge.ip, credentials.username);
      const normalizedGroups = normalizeAreas(response.areas, readinessById);

      patchState((prev) => {
        const flattened = flattenAreaGroups(normalizedGroups);
        const hasStored = prev.selectedAreaId && flattened.some((area) => area.id === prev.selectedAreaId);
        const nextSelectedAreaId = hasStored ? prev.selectedAreaId : flattened[0]?.id ?? null;

        void shellStore.save({
          lastHueAreaId: nextSelectedAreaId ?? undefined,
          hueOnboardingStep: HUE_ONBOARDING_STEP.AREA_SELECT,
        });

        return {
          ...prev,
          areaGroups: normalizedGroups,
          selectedAreaId: nextSelectedAreaId,
          isLoadingAreas: false,
          status: response.status,
        };
      });
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isLoadingAreas: false,
        status: {
          code: CODE.AREA_LIST_FAILED,
          message: "Could not list Hue entertainment areas.",
          details: toErrorDetails(error),
        },
      }));
    }
  }, [patchState, readinessById, selectedBridge]);

  const refreshAreas = useCallback(async () => {
    await refreshAreasWith(state.credentials);
  }, [refreshAreasWith, state.credentials]);

  const discover = useCallback(async () => {
    patchState((prev) => ({
      ...prev,
      isDiscovering: true,
    }));

    try {
      const response = await discoverHueBridges();
      patchState((prev) => {
        const merged = dedupeBridges([...response.bridges, ...prev.bridges]);
        const selectedExists = prev.selectedBridgeId && merged.some((bridge) => bridge.id === prev.selectedBridgeId);
        const selectedBridgeId = selectedExists ? prev.selectedBridgeId : merged[0]?.id ?? null;
        return {
          ...prev,
          bridges: merged,
          selectedBridgeId,
          isDiscovering: false,
          status: response.status,
        };
      });
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isDiscovering: false,
        status: {
          code: CODE.DISCOVERY_FAILED,
          message: "Could not discover Hue bridges.",
          details: toErrorDetails(error),
        },
      }));
    }
  }, [patchState]);

  const setManualIp = useCallback(
    (value: string) => {
      patchState((prev) => ({
        ...prev,
        manualIp: value,
        manualIpError: resolveManualIpError(value),
      }));
    },
    [patchState],
  );

  const selectBridge = useCallback(
    (bridgeId: string | null) => {
      patchState((prev) => ({
        ...prev,
        selectedBridgeId: bridgeId,
        // Clear unreachable flag when bridge is removed or a different bridge is selected.
        bridgeUnreachable: bridgeId !== null && bridgeId === prev.selectedBridgeId ? prev.bridgeUnreachable : false,
      }));
    },
    [patchState],
  );

  const submitManualIp = useCallback(async () => {
    const manualIp = normalizeIpValue(state.manualIp);
    const ipError = resolveManualIpError(manualIp);
    if (ipError) {
      patchState((prev) => ({
        ...prev,
        manualIp: manualIp,
        manualIpError: ipError,
      }));
      return;
    }

    patchState((prev) => ({
      ...prev,
      isDiscovering: true,
      manualIp: manualIp,
      manualIpError: null,
    }));

    try {
      const response = await verifyHueBridgeIp(manualIp);
      patchState((prev) => {
        const bridge = response.bridge;
        const bridges = bridge ? dedupeBridges([bridge, ...prev.bridges]) : prev.bridges;
        const selectedBridgeId = bridge?.id ?? prev.selectedBridgeId;
        if (bridge) {
          void shellStore.save({
            lastHueBridge: bridge,
          });
        }

        return {
          ...prev,
          bridges,
          selectedBridgeId,
          isDiscovering: false,
          status: response.status,
        };
      });
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isDiscovering: false,
        status: {
          code: CODE.IP_UNREACHABLE,
          message: "Could not verify Hue bridge IP.",
          details: toErrorDetails(error),
        },
      }));
    }
  }, [patchState, state.manualIp]);

  const pair = useCallback(async () => {
    if (!selectedBridge) {
      return;
    }

    patchState((prev) => ({
      ...prev,
      isPairing: true,
    }));

    try {
      const response = await pairHueBridge(selectedBridge.ip);
      patchState((prev) => ({
        ...prev,
        credentials: response.credentials,
        credentialState: response.credentials
          ? HUE_CREDENTIAL_STATUS.VALID
          : HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
        // HUE_PAIRING_FAILED is used for both network errors and bridge rejections.
        // If the bridge actually responded (link button, ok, etc.) we know it's reachable.
        // For HUE_PAIRING_FAILED we can't tell, so preserve existing state.
        bridgeUnreachable: response.status.code === "HUE_PAIRING_FAILED" ? prev.bridgeUnreachable : false,
        isPairing: false,
        // Contract status omits `details`; this hook's state nulls it.
        status: { ...response.status, details: response.status.details ?? null },
      }));

      if (response.credentials) {
        // hueAppKey deliberately stays on disk — see docs/architecture/hue.md.
        const keychainOwnsPsk =
          response.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN;

        await shellStore.save({
          lastHueBridge: selectedBridge,
          hueAppKey: response.credentials.username,
          // `undefined` is dropped by the IPC JSON serialisation, so this
          // removes the key rather than writing an empty value over it.
          hueClientKey: keychainOwnsPsk ? undefined : response.credentials.clientKey,
          credentialStorageBackend: keychainOwnsPsk
            ? HUE_CREDENTIAL_BACKENDS.KEYCHAIN
            : HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY,
          hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
          hueOnboardingStep: HUE_ONBOARDING_STEP.PAIR,
        });
        await refreshAreasWith(response.credentials);
      }
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
        isPairing: false,
        status: {
          code: CODE.PAIRING_FAILED,
          message: "Pairing request failed.",
          details: toErrorDetails(error),
        },
      }));
    }
  }, [patchState, refreshAreasWith, selectedBridge]);

  const selectArea = useCallback(
    (areaId: string | null) => {
      patchState((prev) => ({
        ...prev,
        selectedAreaId: areaId,
      }));

      void shellStore.save({
        lastHueAreaId: areaId ?? undefined,
        hueOnboardingStep: areaId ? HUE_ONBOARDING_STEP.AREA_SELECT : HUE_ONBOARDING_STEP.PAIR,
      });
    },
    [patchState],
  );

  const revalidateArea = useCallback(async () => {
    if (!selectedBridge || !state.credentials || !state.selectedAreaId) {
      return;
    }

    patchState((prev) => ({
      ...prev,
      isCheckingReadiness: true,
    }));

    try {
      const response = await checkHueStreamReadiness(
        selectedBridge.ip,
        state.credentials.username,
        state.selectedAreaId,
      );

      applyReadinessResult(state.selectedAreaId, response, {
        publishStatus: true,
        persistReadyStep: true,
      });

      patchState((prev) => ({
        ...prev,
        isCheckingReadiness: false,
      }));
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isCheckingReadiness: false,
        status: {
          code: CODE.STREAM_READINESS_FAILED,
          message: "Could not evaluate Hue stream readiness.",
          details: toErrorDetails(error),
        },
      }));
    }
  }, [applyReadinessResult, patchState, selectedBridge, state.credentials, state.selectedAreaId]);

  const selectedAreaIsBlocked = useMemo(
    () =>
      flattenAreaGroups(state.areaGroups).some(
        (area) => area.id === state.selectedAreaId && area.activeStreamer === true,
      ),
    [state.areaGroups, state.selectedAreaId],
  );

  // Background readiness refresh.
  //
  // Two cadences share one effect:
  //   * 15 s while the selected area is healthy (default polish cadence)
  //   * 3 s while the area is blocked by a foreign active streamer, so
  //     the active-streamer banner clears within ~3 s of the foreign
  //     session disconnecting (A3.1 — previously the banner stayed
  //     stuck until the user clicked revalidate).
  //
  // Visibility-aware: the loop pauses while `document.visibilityState`
  // is `hidden` (tray window collapsed / minimised) and re-arms with an
  // immediate tick on `visibilitychange`, mirroring the runtime-status
  // loop below and `useRuntimeTelemetry`.
  useEffect(() => {
    if (!selectedBridge || !state.credentials || !state.selectedAreaId || state.isValidatingCredential || state.isLoadingAreas) {
      return;
    }

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;
    const bridgeIp = selectedBridge.ip;
    const username = state.credentials.username;
    const areaId = state.selectedAreaId;
    const cadence = selectedAreaIsBlocked
      ? READINESS_BLOCKED_REFRESH_MS
      : READINESS_BACKGROUND_REFRESH_MS;

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await readHueStreamReadiness(bridgeIp, username, areaId);
        if (!mounted) return;
        applyReadinessResult(areaId, response, {
          publishStatus: false,
          persistReadyStep: false,
        });
      } catch {
        // Background readiness refresh is best-effort.
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, cadence);
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible" && timeoutId === null && !inFlight) {
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [applyReadinessResult, selectedAreaIsBlocked, selectedBridge, state.credentials, state.isValidatingCredential, state.isLoadingAreas, state.selectedAreaId]);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      let storedState;
      try {
        storedState = await shellStore.load();
      } catch {
        return;
      }

      if (cancelled) {
        return;
      }

      const savedBridge = storedState.lastHueBridge ?? null;
      // App key alone; demanding both strands the user — docs/architecture/hue.md.
      const savedCredentials = storedState.hueAppKey
        ? {
            username: storedState.hueAppKey,
            clientKey: storedState.hueClientKey ?? "",
          }
        : null;

      const initialReadiness = new Map<string, HueAreaReadiness>();

      patchState((prev) => ({
        ...prev,
        step: toStepFromPersisted(storedState.hueOnboardingStep),
        bridges: savedBridge ? dedupeBridges([savedBridge, ...prev.bridges]) : prev.bridges,
        selectedBridgeId: savedBridge?.id ?? prev.selectedBridgeId,
        selectedAreaId: storedState.lastHueAreaId ?? prev.selectedAreaId,
        credentialState: storedState.hueCredentialStatus ?? HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
        credentials: savedCredentials,
      }));

      await migrateStoredCredentialsToKeychain(storedState);

      if (!savedBridge || !savedCredentials?.username) {
        return;
      }

      patchState((prev) => ({
        ...prev,
        credentialState: HUE_CREDENTIAL_STATUS.UNKNOWN,
        isValidatingCredential: true,
      }));

      try {
        const validation = await validateHueCredentials(savedBridge.ip, savedCredentials.username, savedCredentials.clientKey);
        if (cancelled) {
          return;
        }

        patchState((prev) => ({
          ...prev,
          credentialState: validation.valid
            ? HUE_CREDENTIAL_STATUS.VALID
            : HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
          // HUE_CREDENTIAL_CHECK_FAILED = network error (bridge offline).
          // HUE_CREDENTIAL_INVALID = bridge responded but auth is wrong.
          // Any other case (success or unexpected) = bridge was reachable.
          bridgeUnreachable: !validation.valid && validation.status.code === "HUE_CREDENTIAL_CHECK_FAILED",
          isValidatingCredential: false,
          status: validation.status,
        }));

        await shellStore.save({
          hueCredentialStatus: validation.valid
            ? HUE_CREDENTIAL_STATUS.VALID
            : HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
        });

        if (!validation.valid) {
          return;
        }

        const areas = await listHueEntertainmentAreas(savedBridge.ip, savedCredentials.username);
        if (cancelled) {
          return;
        }

        const areaGroups = normalizeAreas(areas.areas, initialReadiness);
        patchState((prev) => ({
          ...prev,
          areaGroups,
          status: areas.status,
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }

        patchState((prev) => ({
          ...prev,
          credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
          bridgeUnreachable: true,
          isValidatingCredential: false,
          status: {
            code: CODE.CREDENTIAL_CHECK_FAILED,
            message: "Could not validate saved Hue credentials.",
            details: toErrorDetails(error),
          },
        }));
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [patchState]);

  // `force` bypasses the shared read cache. Mandatory after a mutation: a
  // cached pre-mutation status would paint the Devices tab with the state the
  // user just changed away from.
  const pollRuntimeStatus = useCallback(async (options?: { force?: boolean }) => {
    try {
      const result = await readHueStreamStatus(options?.force ? 0 : undefined);
      const nextStatus = result.status as HueRuntimeStatus;
      setRuntimeStatus(nextStatus);
      setRuntimeTargets(deriveRuntimeTargets(nextStatus));
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const fallbackStatus: HueRuntimeStatus = {
        state: "Failed",
        code: CODE.STREAM_STATUS_UNAVAILABLE,
        message: "Could not fetch Hue runtime status.",
        details,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM,
      };
      setRuntimeStatus(fallbackStatus);
      setRuntimeTargets(deriveRuntimeTargets(fallbackStatus));
    }
  }, []);

  // Runtime-status loop. Two concerns share one effect:
  //   1) "What's the bridge doing right now?" — fired on mount and on every
  //      runtime-state change so the Devices tab always opens with a fresh
  //      answer without a polling delay.
  //   2) Streaming health watch — recursive setTimeout at
  //      `RUNTIME_POLL_INTERVAL_MS` cadence, but ONLY while the runtime is
  //      `Starting` / `Running` / `Reconnecting`. Idle / Stopping / Failed
  //      get the mount tick and then go silent.
  // Visibility-aware: the loop pauses while `document.visibilityState` is
  // `hidden` (tray window collapsed / minimised) and re-arms with an
  // immediate tick on `visibilitychange`, mirroring `useRuntimeTelemetry`.
  const runtimeState = runtimeStatus?.state ?? null;
  useEffect(() => {
    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;

    const isStreaming = runtimeState !== null && STREAMING_RUNTIME_STATES.has(runtimeState);

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      lastRuntimePollAtRef.current = Date.now();
      try {
        await pollRuntimeStatus();
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    // `runtimeState` sits in the deps but only ever moves because a poll just
    // returned it, so the unconditional entry tick re-fetched data we already
    // held — a Idle→Starting→Running burst cost three bridge round-trips.
    // Nothing is lost by skipping it: mount and visibility-resume both have a
    // stale enough `lastRuntimePollAt` to tick normally.
    const tickIfStale = () => {
      if (!mounted) return;
      if (timeoutId !== null || inFlight) return;
      if (Date.now() - lastRuntimePollAtRef.current >= RUNTIME_POLL_MIN_INTERVAL_MS) {
        void tick();
      } else {
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted) return;
      if (!isStreaming) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, RUNTIME_POLL_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible") tickIfStale();
    };

    tickIfStale();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pollRuntimeStatus, runtimeState]);

  const startRuntime = useCallback(async () => {
    if (isRuntimeMutating || !selectedBridge || !state.credentials || !state.selectedAreaId) {
      return;
    }

    setIsRuntimeMutating(true);
    try {
      await startHue({
        bridgeIp: selectedBridge.ip,
        username: state.credentials.username,
        clientKey: state.credentials.clientKey,
        areaId: state.selectedAreaId,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        channelRegionOverrides: Object.keys(channelRegionOverrides).length > 0 ? channelRegionOverrides : undefined,
      });
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        status: {
          code: CODE.STREAM_START_FAILED,
          message: "Could not start Hue stream.",
          details: toErrorDetails(error),
        },
      }));
    } finally {
      await pollRuntimeStatus({ force: true });
      setIsRuntimeMutating(false);
    }
  }, [channelRegionOverrides, isRuntimeMutating, patchState, pollRuntimeStatus, selectedBridge, state.credentials, state.selectedAreaId]);

  const retryRuntimeTarget = useCallback(
    async (target: HueRuntimeTarget) => {
      if (isRuntimeMutating || target !== "hue") {
        return;
      }

      setIsRuntimeMutating(true);
      try {
        if (selectedBridge && state.credentials && state.selectedAreaId) {
          await restartHue({
            bridgeIp: selectedBridge.ip,
            username: state.credentials.username,
            clientKey: state.credentials.clientKey,
            areaId: state.selectedAreaId,
            triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
            channelRegionOverrides: Object.keys(channelRegionOverrides).length > 0 ? channelRegionOverrides : undefined,
          });
        }
      } catch (error) {
        patchState((prev) => ({
          ...prev,
          status: {
            code: CODE.STREAM_RECOVERY_FAILED,
            message: "Could not recover Hue stream.",
            details: toErrorDetails(error),
          },
        }));
      } finally {
        await pollRuntimeStatus({ force: true });
        setIsRuntimeMutating(false);
      }
    },
    [channelRegionOverrides, isRuntimeMutating, patchState, pollRuntimeStatus, selectedBridge, state.credentials, state.selectedAreaId],
  );

  return {
    step: state.step,
    bridges: state.bridges,
    selectedBridgeId: state.selectedBridgeId,
    selectedBridge,
    manualIp: state.manualIp,
    manualIpError: state.manualIpError,
    credentialState: state.credentialState,
    bridgeUnreachable: state.bridgeUnreachable,
    credentials: state.credentials,
    areaGroups: state.areaGroups,
    selectedAreaId: state.selectedAreaId,
    selectedArea,
    canStartHue,
    isReadinessStale,
    isDiscovering: state.isDiscovering,
    isPairing: state.isPairing,
    isLoadingAreas: state.isLoadingAreas,
    isCheckingReadiness: state.isCheckingReadiness,
    isValidatingCredential: state.isValidatingCredential,
    status: state.status,
    runtimeStatus,
    runtimeTargets,
    isRuntimeMutating,
    areaChannels,
    isLoadingChannels,
    channelRegionOverrides,
    setChannelRegion,
    discover,
    selectBridge,
    setManualIp,
    submitManualIp,
    pair,
    refreshAreas,
    selectArea,
    revalidateArea,
    startRuntime,
    retryRuntimeTarget,
  };
}
