import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { DeviceCategory, DeviceCategoryRequest } from "@/features/settings/sections/DeviceSection";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";
import { createStore, useStoreSelector, type Store } from "@/shared/lib/store";
import { useStableHandlers } from "@/shared/lib/useStableCallback";

export interface NavigationState {
  /** Mirrored from `useUIMode`, which owns the fade and the window resize. */
  uiMode: UIMode;
  activeSection: SectionId;
  /** A notice asked for one Devices category; forwarded to the rail. */
  deviceCategoryRequest: DeviceCategoryRequest | null;
  /**
   * Reported by the mounted Devices page, `null` while it is not mounted. The
   * rail owns the choice; this copy lets the shell tell which screen is up.
   */
  visibleDeviceCategory: DeviceCategory | null;
}

export interface NavigationStore extends Store<NavigationState> {
  /** Every way in except a notice keeps the Devices category that is open. */
  setActiveSection: (sectionId: SectionId) => void;
  /** Section and category in one write, so no render sees one without the other. */
  openSection: (sectionId: SectionId, deviceCategory?: DeviceCategory) => void;
  setUIMode: (uiMode: UIMode) => void;
  setVisibleDeviceCategory: (category: DeviceCategory | null) => void;
}

export function createNavigationStore(): NavigationStore {
  const store = createStore<NavigationState>({
    uiMode: "compact",
    activeSection: SECTION_IDS.LIGHTS,
    deviceCategoryRequest: null,
    visibleDeviceCategory: null,
  });
  const patch = (next: Partial<NavigationState>) => {
    const current = store.get();
    const changed = (Object.keys(next) as (keyof NavigationState)[]).some(
      (key) => !Object.is(current[key], next[key]),
    );
    if (changed) store.set({ ...current, ...next });
  };
  return {
    ...store,
    setActiveSection: (activeSection) => patch({ activeSection }),
    openSection: (activeSection, deviceCategory) =>
      patch({
        activeSection,
        deviceCategoryRequest:
          deviceCategory === undefined ? null : { category: deviceCategory, nonce: Date.now() },
      }),
    setUIMode: (uiMode) => patch({ uiMode }),
    setVisibleDeviceCategory: (visibleDeviceCategory) => patch({ visibleDeviceCategory }),
  };
}

export interface NavigationActions {
  /**
   * The one way to another section. Leaves compact for anything but Lights,
   * since compact never shows `activeSection`, and persists the choice.
   */
  goToSection: (sectionId: SectionId, deviceCategory?: DeviceCategory) => Promise<void>;
  switchUIMode: (uiMode: UIMode) => Promise<void>;
}

interface Navigation {
  store: NavigationStore;
  actions: NavigationActions;
}

const NavigationContext = createContext<Navigation | null>(null);

/** `actions` may be fresh closures every render; consumers see one stable object. */
export function NavigationProvider({
  store,
  actions,
  children,
}: {
  store: NavigationStore;
  actions: NavigationActions;
  children: ReactNode;
}) {
  const stableActions = useStableHandlers(actions);
  const value = useMemo(() => ({ store, actions: stableActions }), [store, stableActions]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (navigation === null) throw new Error("Navigation used outside NavigationProvider");
  return navigation;
}

export function useNavigationState<S>(
  selector: (state: NavigationState) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  return useStoreSelector(useNavigation().store, selector, isEqual);
}

/** For the Devices page to report its rail. Identity-stable. */
export function useVisibleDeviceCategoryReporter(): NavigationStore["setVisibleDeviceCategory"] {
  return useNavigation().store.setVisibleDeviceCategory;
}

/** Identity-stable for the provider's lifetime. */
export function useNavigationActions(): NavigationActions {
  return useNavigation().actions;
}
