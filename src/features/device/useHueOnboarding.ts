import { useCallback, useEffect, useMemo, useState } from "react";

import {
  HUE_CREDENTIAL_STATUS,
  HUE_ONBOARDING_STEP,
  type HueCredentialStatus,
} from "../../shared/contracts/hue";
import { shellStore } from "../persistence/shellStore";
import {
  checkHueStreamReadiness,
  discoverHueBridges,
  listHueEntertainmentAreas,
  pairHueBridge,
  type CommandStatus,
  type HueBridgeSummary,
  type HueEntertainmentAreaSummary,
  type HuePairingCredentials,
  validateHueCredentials,
  verifyHueBridgeIp,
} from "./hueOnboardingApi";

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

type HueStep = "discover" | "pair" | "area" | "ready";

export interface HueAreaReadiness {
  ready: boolean;
  reasons: string[];
  code: string;
  message: string;
  details: string | null;
}

export interface HueAreaRow extends HueEntertainmentAreaSummary {
  roomLabel: string;
  sortRoomKey: string;
  sortNameKey: string;
  readiness: HueAreaReadiness | null;
}

export interface HueAreaGroup {
  roomName: string;
  areas: HueAreaRow[];
}

export interface UseHueOnboardingResult {
  step: HueStep;
  bridges: HueBridgeSummary[];
  selectedBridgeId: string | null;
  selectedBridge: HueBridgeSummary | null;
  manualIp: string;
  manualIpError: string | null;
  credentialState: HueCredentialStatus;
  credentials: HuePairingCredentials | null;
  areaGroups: HueAreaGroup[];
  selectedAreaId: string | null;
  selectedArea: HueAreaRow | null;
  canStartHue: boolean;
  isDiscovering: boolean;
  isPairing: boolean;
  isLoadingAreas: boolean;
  isCheckingReadiness: boolean;
  isValidatingCredential: boolean;
  status: CommandStatus | null;
  discover: () => Promise<void>;
  selectBridge: (bridgeId: string | null) => void;
  setManualIp: (value: string) => void;
  submitManualIp: () => Promise<void>;
  pair: () => Promise<void>;
  refreshAreas: () => Promise<void>;
  selectArea: (areaId: string | null) => void;
  revalidateArea: () => Promise<void>;
}

interface HueOnboardingState {
  step: HueStep;
  bridges: HueBridgeSummary[];
  selectedBridgeId: string | null;
  manualIp: string;
  manualIpError: string | null;
  credentialState: HueCredentialStatus;
  credentials: HuePairingCredentials | null;
  areaGroups: HueAreaGroup[];
  selectedAreaId: string | null;
  isDiscovering: boolean;
  isPairing: boolean;
  isLoadingAreas: boolean;
  isCheckingReadiness: boolean;
  isValidatingCredential: boolean;
  status: CommandStatus | null;
}

const DEFAULT_STATE: HueOnboardingState = {
  step: "discover",
  bridges: [],
  selectedBridgeId: null,
  manualIp: "",
  manualIpError: null,
  credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
  credentials: null,
  areaGroups: [],
  selectedAreaId: null,
  isDiscovering: false,
  isPairing: false,
  isLoadingAreas: false,
  isCheckingReadiness: false,
  isValidatingCredential: false,
  status: null,
};

function toStepFromPersisted(value: string | undefined): HueStep {
  if (value === HUE_ONBOARDING_STEP.PAIR) {
    return "pair";
  }

  if (value === HUE_ONBOARDING_STEP.AREA_SELECT) {
    return "area";
  }

  if (value === HUE_ONBOARDING_STEP.READY) {
    return "ready";
  }

  return "discover";
}

function normalizeIpValue(value: string): string {
  return value.trim();
}

function resolveManualIpError(value: string): string | null {
  const normalized = normalizeIpValue(value);
  if (normalized.length === 0) {
    return null;
  }

  return IPV4_PATTERN.test(normalized) ? null : "device.hue.manualIp.invalid";
}

function dedupeBridges(bridges: HueBridgeSummary[]): HueBridgeSummary[] {
  const byId = new Map<string, HueBridgeSummary>();
  for (const bridge of bridges) {
    byId.set(bridge.id, bridge);
  }
  return Array.from(byId.values());
}

function normalizeAreas(
  areas: HueEntertainmentAreaSummary[],
  readinessById: Map<string, HueAreaReadiness>,
): HueAreaGroup[] {
  const rows: HueAreaRow[] = areas.map((area) => {
    const room = area.roomName?.trim();
    return {
      ...area,
      roomLabel: room && room.length > 0 ? room : "Other rooms",
      sortRoomKey: (room ?? "other rooms").toLocaleLowerCase(),
      sortNameKey: area.name.toLocaleLowerCase(),
      readiness: readinessById.get(area.id) ?? null,
    };
  });

  rows.sort((left, right) => {
    const roomOrder = left.sortRoomKey.localeCompare(right.sortRoomKey);
    if (roomOrder !== 0) {
      return roomOrder;
    }

    return left.sortNameKey.localeCompare(right.sortNameKey);
  });

  const groups = new Map<string, HueAreaGroup>();
  for (const row of rows) {
    const existing = groups.get(row.roomLabel);
    if (existing) {
      existing.areas.push(row);
      continue;
    }

    groups.set(row.roomLabel, {
      roomName: row.roomLabel,
      areas: [row],
    });
  }

  return Array.from(groups.values());
}

function flattenAreaGroups(areaGroups: HueAreaGroup[]): HueAreaRow[] {
  return areaGroups.flatMap((group) => group.areas);
}

function deriveStep(state: Pick<HueOnboardingState, "selectedBridgeId" | "credentialState" | "selectedAreaId" | "areaGroups">): HueStep {
  if (!state.selectedBridgeId) {
    return "discover";
  }

  if (state.credentialState !== HUE_CREDENTIAL_STATUS.VALID) {
    return "pair";
  }

  if (!state.selectedAreaId) {
    return "area";
  }

  const selectedArea = flattenAreaGroups(state.areaGroups).find((area) => area.id === state.selectedAreaId);
  if (!selectedArea?.readiness?.ready) {
    return "ready";
  }

  return "ready";
}

async function persistResumeState(step: HueStep): Promise<void> {
  const mapped =
    step === "discover"
      ? HUE_ONBOARDING_STEP.DISCOVER
      : step === "pair"
        ? HUE_ONBOARDING_STEP.PAIR
        : step === "area"
          ? HUE_ONBOARDING_STEP.AREA_SELECT
          : HUE_ONBOARDING_STEP.READY;

  await shellStore.save({ hueOnboardingStep: mapped });
}

export function useHueOnboarding(): UseHueOnboardingResult {
  const [state, setState] = useState<HueOnboardingState>(DEFAULT_STATE);
  const [readinessById, setReadinessById] = useState<Map<string, HueAreaReadiness>>(new Map());

  const selectedBridge = useMemo(
    () => state.bridges.find((bridge) => bridge.id === state.selectedBridgeId) ?? null,
    [state.bridges, state.selectedBridgeId],
  );

  const selectedArea = useMemo(() => {
    return flattenAreaGroups(state.areaGroups).find((area) => area.id === state.selectedAreaId) ?? null;
  }, [state.areaGroups, state.selectedAreaId]);

  const canStartHue = useMemo(() => {
    return Boolean(
      selectedBridge &&
        state.credentials &&
        state.credentialState === HUE_CREDENTIAL_STATUS.VALID &&
        selectedArea &&
        selectedArea.readiness?.ready,
    );
  }, [selectedBridge, selectedArea, state.credentials, state.credentialState]);

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

  const refreshAreas = useCallback(async () => {
    if (!selectedBridge || !state.credentials) {
      return;
    }

    patchState((prev) => ({
      ...prev,
      isLoadingAreas: true,
    }));

    try {
      const response = await listHueEntertainmentAreas(selectedBridge.ip, state.credentials.username);
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
          code: "HUE_AREA_LIST_FAILED",
          message: "Could not list Hue entertainment areas.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, [patchState, readinessById, selectedBridge, state.credentials]);

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
          code: "HUE_DISCOVERY_FAILED",
          message: "Could not discover Hue bridges.",
          details: error instanceof Error ? error.message : String(error),
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
          code: "HUE_IP_UNREACHABLE",
          message: "Could not verify Hue bridge IP.",
          details: error instanceof Error ? error.message : String(error),
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
        isPairing: false,
        status: response.status,
      }));

      if (response.credentials) {
        await shellStore.save({
          lastHueBridge: selectedBridge,
          hueAppKey: response.credentials.username,
          hueClientKey: response.credentials.clientKey,
          hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
          hueOnboardingStep: HUE_ONBOARDING_STEP.PAIR,
        });
        await refreshAreas();
      }
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        credentialState: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
        isPairing: false,
        status: {
          code: "HUE_PAIRING_FAILED",
          message: "Pairing request failed.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, [patchState, refreshAreas, selectedBridge]);

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

      setReadinessById((prev) => {
        const next = new Map(prev);
        next.set(state.selectedAreaId as string, {
          ready: response.readiness.ready,
          reasons: response.readiness.reasons,
          code: response.status.code,
          message: response.status.message,
          details: response.status.details,
        });
        return next;
      });

      patchState((prev) => {
        const refreshedGroups = normalizeAreas(flattenAreaGroups(prev.areaGroups), new Map(readinessById).set(state.selectedAreaId as string, {
          ready: response.readiness.ready,
          reasons: response.readiness.reasons,
          code: response.status.code,
          message: response.status.message,
          details: response.status.details,
        }));

        if (response.readiness.ready) {
          void shellStore.save({
            hueOnboardingStep: HUE_ONBOARDING_STEP.READY,
          });
        }

        return {
          ...prev,
          areaGroups: refreshedGroups,
          isCheckingReadiness: false,
          status: response.status,
        };
      });
    } catch (error) {
      patchState((prev) => ({
        ...prev,
        isCheckingReadiness: false,
        status: {
          code: "HUE_STREAM_READINESS_FAILED",
          message: "Could not evaluate Hue stream readiness.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, [patchState, readinessById, selectedBridge, state.credentials, state.selectedAreaId]);

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
      const savedCredentials =
        storedState.hueAppKey && storedState.hueClientKey
          ? {
              username: storedState.hueAppKey,
              clientKey: storedState.hueClientKey,
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

      if (!savedBridge || !savedCredentials?.username) {
        return;
      }

      patchState((prev) => ({
        ...prev,
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
          isValidatingCredential: false,
          status: {
            code: "HUE_CREDENTIAL_CHECK_FAILED",
            message: "Could not validate saved Hue credentials.",
            details: error instanceof Error ? error.message : String(error),
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
    step: state.step,
    bridges: state.bridges,
    selectedBridgeId: state.selectedBridgeId,
    selectedBridge,
    manualIp: state.manualIp,
    manualIpError: state.manualIpError,
    credentialState: state.credentialState,
    credentials: state.credentials,
    areaGroups: state.areaGroups,
    selectedAreaId: state.selectedAreaId,
    selectedArea,
    canStartHue,
    isDiscovering: state.isDiscovering,
    isPairing: state.isPairing,
    isLoadingAreas: state.isLoadingAreas,
    isCheckingReadiness: state.isCheckingReadiness,
    isValidatingCredential: state.isValidatingCredential,
    status: state.status,
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
