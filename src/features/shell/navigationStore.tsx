import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { DeviceCategory, DeviceCategoryRequest } from "@/features/device/model/deviceCategories";
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
  /**
   * LED Setup, open over Devices on a strip; `null` while it is not. A `null` strip is the one a
   * layout with no strip named applies to — the driven strip, or the first one to be made.
   */
  ledSetup: { stripId: string | null } | null;
}

/**
 * Asked before the open screen is taken away. Returns `true` to hold the move:
 * the guard then owns `proceed` and calls it once the user agrees (or never).
 */
export type LeaveGuard = (proceed: () => void) => boolean;

export interface NavigationStore extends Store<NavigationState> {
  /** Every way in except a notice keeps the Devices category that is open. */
  setActiveSection: (sectionId: SectionId) => void;
  /** Section and category in one write, so no render sees one without the other. */
  openSection: (sectionId: SectionId, deviceCategory?: DeviceCategory) => void;
  /** Devices with LED Setup open on `stripId`, in one write. */
  openLedSetup: (stripId: string | null) => void;
  closeLedSetup: () => void;
  setUIMode: (uiMode: UIMode) => void;
  setVisibleDeviceCategory: (category: DeviceCategory | null) => void;
  /** One guard at a time — the mounted screen with unsaved work. `null` clears it. */
  setLeaveGuard: (guard: LeaveGuard | null) => void;
  /** Runs `proceed` now, or hands it to the registered guard to hold. */
  requestLeave: (proceed: () => void) => void;
}

export function createNavigationStore(): NavigationStore {
  const store = createStore<NavigationState>({
    uiMode: "compact",
    activeSection: SECTION_IDS.LIGHTS,
    deviceCategoryRequest: null,
    visibleDeviceCategory: null,
    ledSetup: null,
  });
  // Not state: nothing renders from it, and a render must not be able to see
  // a guard half-registered.
  let leaveGuard: LeaveGuard | null = null;
  const patch = (next: Partial<NavigationState>) => {
    const current = store.get();
    const changed = (Object.keys(next) as (keyof NavigationState)[]).some(
      (key) => !Object.is(current[key], next[key]),
    );
    if (changed) store.set({ ...current, ...next });
  };
  return {
    ...store,
    // Any other way to a section leaves LED Setup: it is a step inside Devices, not a place to return to.
    setActiveSection: (activeSection) => patch({ activeSection, ledSetup: null }),
    openSection: (activeSection, deviceCategory) =>
      patch({
        activeSection,
        ledSetup: null,
        deviceCategoryRequest:
          deviceCategory === undefined ? null : { category: deviceCategory, nonce: Date.now() },
      }),
    openLedSetup: (stripId) => {
      const open = store.get().ledSetup;
      patch({
        activeSection: SECTION_IDS.DEVICES,
        deviceCategoryRequest: null,
        // The same strip keeps its object, so nothing downstream sees a change.
        ledSetup: open?.stripId === stripId ? open : { stripId },
      });
    },
    closeLedSetup: () => patch({ ledSetup: null }),
    setUIMode: (uiMode) => patch({ uiMode }),
    setVisibleDeviceCategory: (visibleDeviceCategory) => patch({ visibleDeviceCategory }),
    setLeaveGuard: (guard) => {
      leaveGuard = guard;
    },
    requestLeave: (proceed) => {
      if (leaveGuard?.(proceed)) return;
      proceed();
    },
  };
}

export interface NavigationActions {
  /**
   * The one way to another section. Leaves compact for anything but Lights,
   * since compact never shows `activeSection`, and persists the choice.
   */
  goToSection: (sectionId: SectionId, deviceCategory?: DeviceCategory) => Promise<void>;
  /** LED Setup on a strip, over Devices; `null` for the strip a layout with no strip named applies to. */
  openLedSetup: (stripId: string | null) => Promise<void>;
  /** Back from LED Setup to the strip's page, through its leave guard. */
  closeLedSetup: () => void;
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

/** Closes LED Setup without asking: for when what it edits is gone. Identity-stable. */
export function useLedSetupCloser(): NavigationStore["closeLedSetup"] {
  return useNavigation().store.closeLedSetup;
}

/** For a screen holding unsaved work to register its guard. Identity-stable. */
export function useLeaveGuardRegistrar(): NavigationStore["setLeaveGuard"] {
  return useNavigation().store.setLeaveGuard;
}

/** Identity-stable for the provider's lifetime. */
export function useNavigationActions(): NavigationActions {
  return useNavigation().actions;
}
