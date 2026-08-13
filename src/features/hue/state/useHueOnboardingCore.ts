import { useCallback, useEffect, useMemo, useState } from "react";

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_CREDENTIAL_STATUS,
  HUE_ONBOARDING_STEP,
} from "@/shared/contracts/hue";
import type { ShellState } from "@/shared/contracts/shell";
import { shellStore } from "../../persistence/shellStore";
import {
  applyAreaReadinessSnapshot,
  flattenAreaGroups,
  normalizeAreas,
} from "../model/areaGrouping";
import { dedupeBridges, normalizeIpValue, resolveManualIpError } from "../model/bridgeIdentity";
import { deriveStep, toPersistedStep, toStepFromPersisted } from "../model/onboardingStep";
import { HUE_ONBOARDING_TRANSPORT_CODES as CODE, toErrorDetails } from "../model/onboardingStatusCodes";
import {
  DEFAULT_STATE,
  type HueAreaReadiness,
  type HueAreaRow,
  type HueOnboardingState,
  type HueStep,
} from "../model/onboardingTypes";
import { READINESS_STALE_MS } from "../model/pollingCadence";
import {
  checkHueStreamReadiness,
  discoverHueBridges,
  listHueEntertainmentAreas,
  migrateHueCredentials,
  pairHueBridge,
  type CommandStatus,
  type HueBridgeSummary,
  type HuePairingCredentials,
  validateHueCredentials,
  verifyHueBridgeIp,
} from "../hueOnboardingApi";

export interface UseHueOnboardingCoreResult {
  state: HueOnboardingState;
  selectedBridge: HueBridgeSummary | null;
  selectedArea: HueAreaRow | null;
  isReadinessStale: boolean;
  canStartHue: boolean;
  selectedAreaIsBlocked: boolean;
  publishStatus: (status: CommandStatus) => void;
  applyBackgroundReadiness: (
    areaId: string,
    response: Awaited<ReturnType<typeof checkHueStreamReadiness>>,
  ) => void;
  discover: () => Promise<void>;
  selectBridge: (bridgeId: string | null) => void;
  setManualIp: (value: string) => void;
  submitManualIp: () => Promise<void>;
  pair: () => Promise<void>;
  refreshAreas: () => Promise<void>;
  selectArea: (areaId: string | null) => void;
  revalidateArea: () => Promise<void>;
}

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
      hueAppKey: undefined,
      hueClientKey: undefined,
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    });
  } catch (error) {
    console.warn("[LumaSync] Hue credential keychain migration failed", error);
  }
}

/** Discovery, pairing, area listing and foreground readiness share one
 * state object and one patchState, so they are not split further. */
export function useHueOnboardingCore(): UseHueOnboardingCoreResult {
  const [state, setState] = useState<HueOnboardingState>(DEFAULT_STATE);
  const [readinessById, setReadinessById] = useState<Map<string, HueAreaReadiness>>(new Map());
  const [readinessCheckedAtById, setReadinessCheckedAtById] = useState<Map<string, number>>(new Map());

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

  const publishStatus = useCallback(
    (status: CommandStatus) => {
      patchState((prev) => ({ ...prev, status }));
    },
    [patchState],
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
        // Only the literal `"keychain"` licenses the delete — see docs/architecture/hue.md.
        const keychainOwnsCredentials =
          response.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN;

        await shellStore.save({
          lastHueBridge: selectedBridge,
          // `undefined` is dropped by the IPC JSON serialisation, so this
          // removes the key rather than writing an empty value over it.
          hueAppKey: keychainOwnsCredentials ? undefined : response.credentials.username,
          hueClientKey: keychainOwnsCredentials ? undefined : response.credentials.clientKey,
          credentialStorageBackend: keychainOwnsCredentials
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

  const applyBackgroundReadiness = useCallback(
    (areaId: string, response: Awaited<ReturnType<typeof checkHueStreamReadiness>>) => {
      applyReadinessResult(areaId, response, { publishStatus: false, persistReadyStep: false });
    },
    [applyReadinessResult],
  );

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
      // An empty app key is the keychain signal, not "unpaired" — keying off it
      // would skip boot validation entirely. See docs/architecture/hue.md.
      const isPaired =
        !!storedState.hueAppKey ||
        storedState.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN;
      const savedCredentials = isPaired
        ? {
            username: storedState.hueAppKey ?? "",
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

      if (!savedBridge || !savedCredentials) {
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

  return {
    state,
    selectedBridge,
    selectedArea,
    isReadinessStale,
    canStartHue,
    selectedAreaIsBlocked,
    publishStatus,
    applyBackgroundReadiness,
    discover,
    selectBridge,
    setManualIp,
    submitManualIp,
    pair,
    refreshAreas,
    selectArea,
    revalidateArea,
  };
}
