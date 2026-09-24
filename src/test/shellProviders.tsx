// The three shell stores for a test that renders SettingsLayout or a panel
// without App. Every store is driven from outside the rendered tree, so a
// test can move one and count who re-renders.

import { act, render, type RenderResult } from "@testing-library/react";
import { useState, type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";

import {
  LightingControlProvider,
  type LightingControlActions,
  type LightingControlState,
} from "@/features/mode/state/lightingControl";
import {
  createNavigationStore,
  NavigationProvider,
  type NavigationActions,
  type NavigationState,
  type NavigationStore,
} from "@/features/shell/navigationStore";
import {
  UpdaterStoreProvider,
  type UpdaterActions,
  type UpdaterSnapshot,
} from "@/features/updater/UpdaterProvider";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { createStore, type Store } from "@/shared/lib/store";

export const DEFAULT_LIGHTING_STATE: LightingControlState = {
  lightingMode: { kind: "off" },
  outputTargets: ["usb"],
  isModeTransitioning: false,
  modeLockReason: null,
  calibration: undefined,
  localSink: null,
  bootstrapDone: true,
};

export interface ShellTestOptions {
  navigation?: Partial<NavigationState>;
  lighting?: Partial<LightingControlState>;
  lightingActions?: Partial<LightingControlActions>;
  navigationActions?: Partial<NavigationActions>;
  updater?: Partial<UpdaterSnapshot>;
  updaterActions?: Partial<UpdaterActions>;
}

export interface ShellTestControls {
  navigation: NavigationStore;
  updater: Store<UpdaterSnapshot>;
  lightingActions: LightingControlActions;
  navigationActions: NavigationActions;
  updaterActions: UpdaterActions;
  /** A new lighting snapshot, as App publishes one after a runtime revision. */
  setLighting: (patch: Partial<LightingControlState>) => void;
  /** New props for the tree under the stores, as App re-rendering it would pass. */
  rerenderUi: (ui: ReactElement) => void;
}

export function renderWithShellStores(
  ui: ReactElement,
  options: ShellTestOptions = {},
): RenderResult & ShellTestControls {
  const navigation = createNavigationStore();
  navigation.set({ ...navigation.get(), activeSection: SECTION_IDS.LIGHTS, ...options.navigation });
  const updater = createStore<UpdaterSnapshot>({
    state: { status: "idle" },
    isModalOpen: false,
    checkFailedNotice: null,
    ...options.updater,
  });
  const lightingActions: LightingControlActions = {
    changeMode: vi.fn(),
    changeOutputTargets: vi.fn(),
    stopHueOutput: vi.fn(async () => {}),
    saveCalibration: vi.fn(),
    ...options.lightingActions,
  };
  const navigationActions: NavigationActions = {
    goToSection: vi.fn(async () => {}),
    switchUIMode: vi.fn(async () => {}),
    ...options.navigationActions,
  };
  const updaterActions: UpdaterActions = {
    checkForUpdates: vi.fn(async () => {}),
    checkForUpdatesInBackground: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async () => {}),
    dismiss: vi.fn(),
    devSetState: vi.fn(),
    ...options.updaterActions,
  };

  let setLightingState: (next: (prev: LightingControlState) => LightingControlState) => void = () => {};

  // `children` is created once, outside this component, so a harness render
  // reaches the tree only through the stores — the same boundary App has.
  function Harness({ children }: { children: ReactNode }) {
    const [lighting, setLighting] = useState<LightingControlState>({
      ...DEFAULT_LIGHTING_STATE,
      ...options.lighting,
    });
    setLightingState = setLighting;
    return (
      <UpdaterStoreProvider store={updater} actions={updaterActions}>
        <NavigationProvider store={navigation} actions={navigationActions}>
          <LightingControlProvider state={lighting} actions={lightingActions}>
            {children}
          </LightingControlProvider>
        </NavigationProvider>
      </UpdaterStoreProvider>
    );
  }

  const result = render(<Harness>{ui}</Harness>);
  return {
    ...result,
    navigation,
    updater,
    lightingActions,
    navigationActions,
    updaterActions,
    setLighting: (patch) => {
      act(() => setLightingState((prev) => ({ ...prev, ...patch })));
    },
    rerenderUi: (next) => {
      result.rerender(<Harness>{next}</Harness>);
    },
  };
}
