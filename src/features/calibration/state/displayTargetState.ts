import type {
  DisplayId,
  DisplayInfo,
  DisplayOverlayCommandResult,
  OverlayPreviewPayload,
} from "../../../shared/contracts/display";

interface CreateDisplayTargetStateDeps {
  openDisplayOverlay: (
    displayId: DisplayId,
    preview?: OverlayPreviewPayload,
  ) => Promise<DisplayOverlayCommandResult>;
  closeDisplayOverlay: (displayId: DisplayId) => Promise<DisplayOverlayCommandResult>;
}

export interface DisplayTargetSnapshot {
  displays: DisplayInfo[];
  selectedDisplayId: DisplayId | null;
  activeDisplayId: DisplayId | null;
  blocked: boolean;
  blockedCode: string | null;
  blockedReason: string | null;
  isSwitching: boolean;
}

export interface DisplayTargetState {
  getSnapshot: () => DisplayTargetSnapshot;
  setDisplays: (displays: DisplayInfo[]) => DisplayTargetSnapshot;
  selectDisplay: (displayId: DisplayId) => DisplayTargetSnapshot;
  switchActiveDisplay: (
    displayId?: DisplayId | null,
    preview?: OverlayPreviewPayload,
  ) => Promise<DisplayTargetSnapshot>;
  closeActiveDisplay: () => Promise<DisplayTargetSnapshot>;
  clearBlockedState: () => DisplayTargetSnapshot;
}

const DEFAULT_SNAPSHOT: DisplayTargetSnapshot = {
  displays: [],
  selectedDisplayId: null,
  activeDisplayId: null,
  blocked: false,
  blockedCode: null,
  blockedReason: null,
  isSwitching: false,
};

function toBlockedSnapshot(
  snapshot: DisplayTargetSnapshot,
  result?: DisplayOverlayCommandResult,
  fallbackReason?: string,
): DisplayTargetSnapshot {
  return {
    ...snapshot,
    activeDisplayId: null,
    blocked: true,
    blockedCode: result?.code ?? "OVERLAY_OPEN_FAILED",
    blockedReason: result?.reason ?? result?.message ?? fallbackReason ?? null,
    isSwitching: false,
  };
}

export function createDisplayTargetState(deps: CreateDisplayTargetStateDeps): DisplayTargetState {
  let snapshot: DisplayTargetSnapshot = { ...DEFAULT_SNAPSHOT };
  let inFlightSwitch: Promise<DisplayTargetSnapshot> | null = null;

  const getResolvedTargetId = (displayId?: DisplayId | null) => {
    if (displayId && displayId.trim().length > 0) {
      return displayId;
    }

    return snapshot.selectedDisplayId;
  };

  return {
    getSnapshot: () => snapshot,
    setDisplays: (displays) => {
      const normalized = displays.filter((display) => Boolean(display.id));
      const defaultDisplayId =
        normalized.find((display) => display.isPrimary)?.id ?? normalized[0]?.id ?? null;
      const selectedDisplayId =
        snapshot.selectedDisplayId && normalized.some((display) => display.id === snapshot.selectedDisplayId)
          ? snapshot.selectedDisplayId
          : defaultDisplayId;
      const activeDisplayId =
        snapshot.activeDisplayId && normalized.some((display) => display.id === snapshot.activeDisplayId)
          ? snapshot.activeDisplayId
          : null;

      snapshot = {
        ...snapshot,
        displays: normalized,
        selectedDisplayId,
        activeDisplayId,
      };

      return snapshot;
    },
    selectDisplay: (displayId) => {
      snapshot = {
        ...snapshot,
        selectedDisplayId: displayId,
        blocked: false,
        blockedCode: null,
        blockedReason: null,
      };

      return snapshot;
    },
    switchActiveDisplay: async (displayId, preview) => {
      if (inFlightSwitch) {
        return inFlightSwitch;
      }

      const fallbackDisplayId =
        snapshot.displays.find((display) => display.isPrimary)?.id ?? snapshot.displays[0]?.id ?? null;
      const targetDisplayId = getResolvedTargetId(displayId) ?? fallbackDisplayId;
      if (!targetDisplayId) {
        snapshot = {
          ...snapshot,
          activeDisplayId: null,
          blocked: true,
          blockedCode: "OVERLAY_NO_DISPLAY",
          blockedReason: "No display available for calibration overlay.",
          isSwitching: false,
        };
        return snapshot;
      }

      if (snapshot.blocked) {
        return {
          ...snapshot,
          selectedDisplayId: targetDisplayId,
          isSwitching: false,
        };
      }

      if (snapshot.activeDisplayId === targetDisplayId) {
        return {
          ...snapshot,
          selectedDisplayId: targetDisplayId,
        };
      }

      const previousDisplayId = snapshot.activeDisplayId;
      snapshot = {
        ...snapshot,
        selectedDisplayId: targetDisplayId,
        blocked: false,
        blockedCode: null,
        blockedReason: null,
        isSwitching: true,
      };

      inFlightSwitch = (async () => {
        try {
          if (previousDisplayId) {
            await deps.closeDisplayOverlay(previousDisplayId);
          }

          const openResult = await deps.openDisplayOverlay(targetDisplayId, preview);
          if (!openResult.ok) {
            snapshot = toBlockedSnapshot(snapshot, openResult);
            return snapshot;
          }

          snapshot = {
            ...snapshot,
            activeDisplayId: targetDisplayId,
            blocked: false,
            blockedCode: null,
            blockedReason: null,
            isSwitching: false,
          };
          return snapshot;
        } catch (error) {
          snapshot = toBlockedSnapshot(snapshot, undefined, error instanceof Error ? error.message : String(error));
          return snapshot;
        } finally {
          inFlightSwitch = null;
        }
      })();

      return inFlightSwitch;
    },
    closeActiveDisplay: async () => {
      if (snapshot.activeDisplayId) {
        await deps.closeDisplayOverlay(snapshot.activeDisplayId);
      }

      snapshot = {
        ...snapshot,
        activeDisplayId: null,
        isSwitching: false,
      };

      return snapshot;
    },
    clearBlockedState: () => {
      snapshot = {
        ...snapshot,
        blocked: false,
        blockedCode: null,
        blockedReason: null,
      };

      return snapshot;
    },
  };
}
