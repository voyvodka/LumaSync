import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_CREDENTIAL_STATUS,
  HUE_ONBOARDING_STEP,
  HUE_RUNTIME_STATUS,
  HUE_STATUS,
} from "@/shared/contracts/hue";
import type { ShellState } from "@/shared/contracts/shell";
import { parseCommandError } from "@/shared/contracts/status";
import { shellStore } from "../../persistence/shellStore";
import { hueCredentialEvents } from "../hueCredentialEvents";
import {
  applyAreaReadinessSnapshot,
  flattenAreaGroups,
  normalizeAreas,
  readinessOf,
} from "../model/areaGrouping";
import {
  dedupeBridges,
  normalizeIpValue,
  relocatedBridge,
  resolveManualIpError,
  sameBridgeId,
} from "../model/bridgeIdentity";
import { deriveStep, toPersistedStep, toStepFromPersisted } from "../model/onboardingStep";
import {
  HUE_ONBOARDING_TRANSPORT_CODES as CODE,
  HUE_PAIRING_PENDING_LINK_BUTTON,
  type HueOnboardingStatus,
} from "../model/onboardingStatusCodes";
import {
  DEFAULT_STATE,
  type HueAreaReadiness,
  type HueAreaRow,
  type HueOnboardingState,
  type HueStep,
} from "../model/onboardingTypes";
import {
  HUE_PAIRING_POLL_INTERVAL_MS,
  HUE_PAIRING_POLL_WINDOW_MS,
  READINESS_STALE_MS,
} from "../model/pollingCadence";
import {
  checkHueStreamReadiness,
  discoverHueBridges,
  listHueEntertainmentAreas,
  migrateHueCredentials,
  pairHueBridge,
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
  publishStatus: (status: HueOnboardingStatus) => void;
  applyBackgroundReadiness: (
    areaId: string,
    response: Awaited<ReturnType<typeof checkHueStreamReadiness>>,
    checkedAt: number,
  ) => void;
  discover: () => Promise<void>;
  selectBridge: (bridgeId: string | null) => void;
  setManualIp: (value: string) => void;
  submitManualIp: () => Promise<void>;
  recheckBridge: () => Promise<void>;
  pair: (bridgeId?: string) => Promise<void>;
  refreshAreas: () => Promise<void>;
  selectArea: (areaId: string | null) => void;
  revalidateArea: () => Promise<void>;
}

function isPairingStatus(status: HueOnboardingStatus | null): boolean {
  return status?.code.startsWith("HUE_PAIRING_") ?? false;
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
    hueCredentialEvents.emit({ reason: "credentials-migrated" });
  } catch (error) {
    console.warn("[LumaSync] Hue credential keychain migration failed", error);
  }
}

/** Discovery, pairing, area listing and foreground readiness share one
 * state object and one patchState, so they are not split further. */
export function useHueOnboardingCore(): UseHueOnboardingCoreResult {
  const [state, setState] = useState<HueOnboardingState>(DEFAULT_STATE);
  // Read by the async flows after an await, where the render's `state` is stale.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
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
    (status: HueOnboardingStatus) => {
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
        /** When the bridge answered; defaults to now. */
        checkedAt?: number;
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
        next.set(areaId, options?.checkedAt ?? Date.now());
        return next;
      });

      patchState((prev) => {
        const areaGroups = applyAreaReadinessSnapshot(prev.areaGroups, areaId, readiness);

        return {
          ...prev,
          areaGroups,
          // The bridge refused the key mid-session: without this the card kept
          // reading "paired" until the next boot validation.
          credentialState:
            response.status.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED
              ? HUE_CREDENTIAL_STATUS.NEEDS_REPAIR
              : prev.credentialState,
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
  // The bridge is an argument too: a pairing started from "+ Pair" or finished
  // by a timer-driven retry runs before `selectedBridge` has re-rendered.
  const refreshAreasWith = useCallback(async (
    credentials: HuePairingCredentials | null,
    bridge: HueBridgeSummary | null = selectedBridge,
  ) => {
    if (!bridge || !credentials) {
      return;
    }

    patchState((prev) => ({
      ...prev,
      isLoadingAreas: true,
    }));

    try {
      const response = await listHueEntertainmentAreas(bridge.ip, credentials.username);
      const normalizedGroups = normalizeAreas(response.areas, readinessById);

      patchState((prev) => {
        const flattened = flattenAreaGroups(normalizedGroups);
        const hasStored = prev.selectedAreaId && flattened.some((area) => area.id === prev.selectedAreaId);
        const nextSelectedAreaId = hasStored ? prev.selectedAreaId : flattened[0]?.id ?? null;

        // Emit only once the write has landed: the subscriber re-reads the
        // store, so firing early hands it the value this call replaced.
        void shellStore
          .save({
            lastHueAreaId: nextSelectedAreaId ?? undefined,
            hueOnboardingStep: HUE_ONBOARDING_STEP.AREA_SELECT,
          })
          .then(() => hueCredentialEvents.emit({ reason: "area-selected" }));

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
          details: parseCommandError(error).message,
        },
      }));
    }
  }, [patchState, readinessById, selectedBridge]);

  const refreshAreas = useCallback(async () => {
    await refreshAreasWith(state.credentials);
  }, [refreshAreasWith, state.credentials]);

  // Asks the bridge whether the saved key still works, then lists its areas.
  // Boot runs it, and so does anything that has just learned where the
  // bridge is now: Retry, a rediscovery, a new address typed in.
  const validateBridge = useCallback(async (
    bridge: HueBridgeSummary,
    credentials: HuePairingCredentials,
    isCancelled: () => boolean = () => false,
  ) => {
    patchState((prev) => ({
      ...prev,
      credentialState: HUE_CREDENTIAL_STATUS.UNKNOWN,
      isValidatingCredential: true,
    }));

    try {
      const validation = await validateHueCredentials(bridge.ip, credentials.username, credentials.clientKey);
      if (isCancelled()) {
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

      const areas = await listHueEntertainmentAreas(bridge.ip, credentials.username);
      if (isCancelled()) {
        return;
      }

      patchState((prev) => ({
        ...prev,
        // A re-check must not wipe the readiness the rows already carry:
        // Start stays disabled until an area reads ready again.
        areaGroups: normalizeAreas(areas.areas, readinessOf(prev.areaGroups)),
        status: areas.status,
      }));
    } catch (error) {
      if (isCancelled()) {
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
          details: parseCommandError(error).message,
        },
      }));
    }
  }, [patchState]);

  // A bridge DHCP moved keeps its id, so a rediscovery or a typed address is
  // the moment to learn where it went: remember the new address — saving
  // `lastHueBridge` also re-arms the health monitor — and ask it again.
  const adoptBridgeAddress = useCallback(async (
    bridge: HueBridgeSummary,
    moved: boolean,
    current: HueOnboardingState,
  ) => {
    if (moved) {
      await shellStore.save({ lastHueBridge: bridge });
    }
    if (current.credentials && (moved || current.bridgeUnreachable)) {
      await validateBridge(bridge, current.credentials);
    }
  }, [validateBridge]);

  const recheckBridge = useCallback(async () => {
    const current = stateRef.current;
    const bridge = current.bridges.find((candidate) => candidate.id === current.selectedBridgeId);
    if (!bridge || !current.credentials) {
      return;
    }
    await validateBridge(bridge, current.credentials);
  }, [validateBridge]);

  const discover = useCallback(async () => {
    patchState((prev) => ({
      ...prev,
      isDiscovering: true,
    }));

    try {
      const response = await discoverHueBridges();
      const current = stateRef.current;
      const selected = current.bridges.find((bridge) => bridge.id === current.selectedBridgeId) ?? null;
      const moved = selected ? relocatedBridge(selected, response.bridges) : null;
      const found = moved ?? (selected && response.bridges.some((bridge) => sameBridgeId(bridge.id, selected.id))
        ? selected
        : null);
      const fresh = dedupeBridges(response.bridges);

      patchState((prev) => {
        const merged = dedupeBridges([...(moved ? [moved] : []), ...fresh, ...prev.bridges]);
        const selectedExists = prev.selectedBridgeId && merged.some((bridge) => bridge.id === prev.selectedBridgeId);
        // Selecting a bridge hides the list of found ones, so a scan only
        // picks one for the user when there is nothing to choose between.
        const selectedBridgeId = selectedExists
          ? prev.selectedBridgeId
          : fresh.length === 1
            ? fresh[0]?.id ?? null
            : null;
        return {
          ...prev,
          bridges: merged,
          selectedBridgeId,
          isDiscovering: false,
          status: response.status,
        };
      });

      if (found) {
        await adoptBridgeAddress(found, moved !== null, current);
      }
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isDiscovering: false,
        status: {
          code: CODE.DISCOVERY_FAILED,
          message: "Could not discover Hue bridges.",
          details: parseCommandError(error).message,
        },
      }));
    }
  }, [adoptBridgeAddress, patchState]);

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

  const pairingRunRef = useRef(0);
  const pairingBridgeIdRef = useRef<string | null>(null);
  const pairingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bumping the run id orphans any request still in flight: its answer is
  // dropped instead of resurrecting a pairing the user walked away from.
  const stopPairingPoll = useCallback(() => {
    pairingRunRef.current += 1;
    pairingBridgeIdRef.current = null;
    if (pairingTimerRef.current !== null) {
      clearTimeout(pairingTimerRef.current);
      pairingTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPairingPoll, [stopPairingPoll]);

  const selectBridge = useCallback(
    (bridgeId: string | null) => {
      const stopsPairing = pairingBridgeIdRef.current !== null && pairingBridgeIdRef.current !== bridgeId;
      if (stopsPairing) {
        stopPairingPoll();
      }
      patchState((prev) => {
        const bridgeChanged = bridgeId === null || bridgeId !== prev.selectedBridgeId;
        return {
          ...prev,
          selectedBridgeId: bridgeId,
          // Clear unreachable flag when bridge is removed or a different bridge is selected.
          bridgeUnreachable: bridgeChanged ? false : prev.bridgeUnreachable,
          isPairing: stopsPairing ? false : prev.isPairing,
          // A pairing verdict belongs to the bridge it came from; carried over, it
          // lands a reselected bridge straight back on the stale pairing card.
          status: bridgeChanged && isPairingStatus(prev.status) ? null : prev.status,
        };
      });
    },
    [patchState, stopPairingPoll],
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
      const current = stateRef.current;
      const bridge = response.bridge;
      const selected = current.bridges.find((candidate) => candidate.id === current.selectedBridgeId) ?? null;
      const sameAsSelected = bridge !== null && selected !== null && sameBridgeId(bridge.id, selected.id);
      const moved = sameAsSelected && selected ? relocatedBridge(selected, [bridge]) : null;
      // Typed from the offline card while another bridge is paired: the key
      // belongs to that one, so this bridge starts unpaired and the saved
      // bridge stays until the new one is paired.
      const otherBridge = bridge !== null && selected !== null && !sameAsSelected;

      patchState((prev) => {
        const kept = moved ?? (sameAsSelected ? selected : bridge);
        const bridges = kept ? dedupeBridges([kept, ...prev.bridges]) : prev.bridges;
        return {
          ...prev,
          bridges,
          selectedBridgeId: kept?.id ?? prev.selectedBridgeId,
          credentials: otherBridge ? null : prev.credentials,
          credentialState: otherBridge ? HUE_CREDENTIAL_STATUS.UNKNOWN : prev.credentialState,
          bridgeUnreachable: otherBridge ? false : prev.bridgeUnreachable,
          isDiscovering: false,
          status: response.status,
        };
      });

      if (bridge && selected === null) {
        await shellStore.save({ lastHueBridge: bridge });
      } else if (sameAsSelected && selected) {
        await adoptBridgeAddress(moved ?? selected, moved !== null, current);
      }
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isDiscovering: false,
        status: {
          code: CODE.IP_UNREACHABLE,
          message: "Could not verify Hue bridge IP.",
          details: parseCommandError(error).message,
        },
      }));
    }
  }, [adoptBridgeAddress, patchState, state.manualIp]);

  const pair = useCallback(async (bridgeId?: string) => {
    const bridge = bridgeId === undefined
      ? selectedBridge
      : state.bridges.find((candidate) => candidate.id === bridgeId) ?? null;
    if (!bridge) {
      return;
    }

    stopPairingPoll();
    const run = pairingRunRef.current;
    pairingBridgeIdRef.current = bridge.id;
    const deadline = Date.now() + HUE_PAIRING_POLL_WINDOW_MS;

    patchState((prev) => ({
      ...prev,
      selectedBridgeId: bridge.id,
      bridgeUnreachable: bridge.id === prev.selectedBridgeId ? prev.bridgeUnreachable : false,
      isPairing: true,
      status: isPairingStatus(prev.status) ? null : prev.status,
    }));

    const attempt = async (): Promise<void> => {
      try {
        const response = await pairHueBridge(bridge.ip);
        if (run !== pairingRunRef.current) {
          return;
        }

        const waitingForLinkButton =
          response.status.code === HUE_STATUS.PAIRING_LINK_BUTTON_NOT_PRESSED
          && Date.now() + HUE_PAIRING_POLL_INTERVAL_MS <= deadline;

        if (waitingForLinkButton) {
          patchState((prev) => ({
            ...prev,
            credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
            bridgeUnreachable: false,
            isPairing: true,
            status: {
              code: HUE_PAIRING_PENDING_LINK_BUTTON,
              message: "Waiting for the bridge link button to be pressed.",
              details: null,
            },
          }));
          pairingTimerRef.current = setTimeout(() => {
            pairingTimerRef.current = null;
            void attempt();
          }, HUE_PAIRING_POLL_INTERVAL_MS);
          return;
        }

        // Anything else ends the run, including a 101 past the deadline, which
        // the card shows as timed out. Rate-limited and busy answers stop here
        // too: retrying into a throttling bridge only extends the throttle.
        pairingBridgeIdRef.current = null;
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
            lastHueBridge: bridge,
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
          hueCredentialEvents.emit({ reason: "paired" });
          await refreshAreasWith(response.credentials, bridge);
        }
      } catch (error) {
        if (run !== pairingRunRef.current) {
          return;
        }
        pairingBridgeIdRef.current = null;
        patchState((prev) => ({
          ...prev,
          credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
          isPairing: false,
          status: {
            code: CODE.PAIRING_FAILED,
            message: "Pairing request failed.",
            details: parseCommandError(error).message,
          },
        }));
      }
    };

    await attempt();
  }, [patchState, refreshAreasWith, selectedBridge, state.bridges, stopPairingPoll]);

  const selectArea = useCallback(
    (areaId: string | null) => {
      patchState((prev) => ({
        ...prev,
        selectedAreaId: areaId,
      }));

      void shellStore
        .save({
          lastHueAreaId: areaId ?? undefined,
          hueOnboardingStep: areaId ? HUE_ONBOARDING_STEP.AREA_SELECT : HUE_ONBOARDING_STEP.PAIR,
        })
        .then(() => hueCredentialEvents.emit({ reason: "area-selected" }));
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
          details: parseCommandError(error).message,
        },
      }));
    }
  }, [applyReadinessResult, patchState, selectedBridge, state.credentials, state.selectedAreaId]);

  const applyBackgroundReadiness = useCallback(
    (
      areaId: string,
      response: Awaited<ReturnType<typeof checkHueStreamReadiness>>,
      checkedAt: number,
    ) => {
      applyReadinessResult(areaId, response, {
        publishStatus: false,
        persistReadyStep: false,
        checkedAt,
      });
    },
    [applyReadinessResult],
  );

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      let storedState;
      try {
        storedState = await shellStore.load();
      } catch (err) {
        console.error("[LumaSync] Hue onboarding init: shell store load failed:", err);
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

      patchState((prev) => ({
        ...prev,
        step: toStepFromPersisted(storedState.hueOnboardingStep),
        bridges: savedBridge ? dedupeBridges([savedBridge, ...prev.bridges]) : prev.bridges,
        selectedBridgeId: savedBridge?.id ?? prev.selectedBridgeId,
        selectedAreaId: storedState.lastHueAreaId ?? prev.selectedAreaId,
        // Nothing stored is "not paired yet", never "needs re-pair": the
        // latter showed a first-time user expired credentials before pairing.
        credentialState: savedCredentials
          ? storedState.hueCredentialStatus ?? HUE_CREDENTIAL_STATUS.UNKNOWN
          : HUE_CREDENTIAL_STATUS.UNKNOWN,
        credentials: savedCredentials,
      }));

      await migrateStoredCredentialsToKeychain(storedState);

      if (!savedBridge || !savedCredentials) {
        return;
      }

      await validateBridge(savedBridge, savedCredentials, () => cancelled);
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [patchState, validateBridge]);

  return {
    state,
    selectedBridge,
    selectedArea,
    isReadinessStale,
    canStartHue,
    publishStatus,
    applyBackgroundReadiness,
    discover,
    selectBridge,
    setManualIp,
    submitManualIp,
    recheckBridge,
    pair,
    refreshAreas,
    selectArea,
    revalidateArea,
  };
}
