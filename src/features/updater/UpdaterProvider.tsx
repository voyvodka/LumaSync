import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useMirroredStore, useStoreSelector, type Store } from "@/shared/lib/store";
import { useStableHandlers } from "@/shared/lib/useStableCallback";

import { UpdateModal } from "./UpdateModal";
import { useAutoUpdater, type UpdaterState } from "./useAutoUpdater";
import type { UpdateCheckFailure } from "./useUpdateCheckFailedNotice";

export interface UpdaterSnapshot {
  state: UpdaterState;
  isModalOpen: boolean;
  checkFailedNotice: UpdateCheckFailure | null;
  /** When a check the user asked for last found nothing newer; `null` otherwise. */
  upToDateAt: number | null;
}

type AutoUpdater = ReturnType<typeof useAutoUpdater>;

export type UpdaterActions = Pick<
  AutoUpdater,
  "checkForUpdates" | "checkForUpdatesInBackground" | "downloadAndInstall" | "dismiss" | "devSetState"
>;

interface Updater {
  store: Store<UpdaterSnapshot>;
  actions: UpdaterActions;
}

const UpdaterContext = createContext<Updater | null>(null);

/**
 * Owns `useAutoUpdater` above the shell. A download reports progress many
 * times a second; held here, a progress event re-renders this provider and
 * the modal, while the shell below reads only the slices it shows.
 */
export function UpdaterProvider({ children }: { children: ReactNode }) {
  const updater = useAutoUpdater();
  const store = useMirroredStore<UpdaterSnapshot>({
    state: updater.state,
    isModalOpen: updater.isModalOpen,
    checkFailedNotice: updater.checkFailedNotice,
    upToDateAt: updater.upToDateAt,
  });
  return (
    <UpdaterStoreProvider
      store={store}
      actions={{
        checkForUpdates: updater.checkForUpdates,
        checkForUpdatesInBackground: updater.checkForUpdatesInBackground,
        downloadAndInstall: updater.downloadAndInstall,
        dismiss: updater.dismiss,
        devSetState: updater.devSetState,
      }}
    >
      {children}
    </UpdaterStoreProvider>
  );
}

/** The provider without the hook behind it; `actions` may be fresh closures every render. */
export function UpdaterStoreProvider({
  store,
  actions,
  children,
}: {
  store: Store<UpdaterSnapshot>;
  actions: UpdaterActions;
  children: ReactNode;
}) {
  const stableActions = useStableHandlers(actions);
  const value = useMemo(() => ({ store, actions: stableActions }), [store, stableActions]);
  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}

function useUpdater(): Updater {
  const updater = useContext(UpdaterContext);
  if (updater === null) throw new Error("Updater used outside UpdaterProvider");
  return updater;
}

export function useUpdaterState<S>(selector: (snapshot: UpdaterSnapshot) => S, isEqual?: (a: S, b: S) => boolean): S {
  return useStoreSelector(useUpdater().store, selector, isEqual);
}

/** Identity-stable for the provider's lifetime. */
export function useUpdaterActions(): UpdaterActions {
  return useUpdater().actions;
}

const selectModalOpen = (snapshot: UpdaterSnapshot) => snapshot.isModalOpen;
const selectState = (snapshot: UpdaterSnapshot) => snapshot.state;

/** The only subscriber to every progress tick. */
export function UpdateModalHost() {
  const isModalOpen = useUpdaterState(selectModalOpen);
  const state = useUpdaterState(selectState);
  const { downloadAndInstall, dismiss, checkForUpdates } = useUpdaterActions();
  if (!isModalOpen) return null;
  return (
    <UpdateModal
      state={state}
      onInstall={downloadAndInstall}
      onDismiss={dismiss}
      onRetry={() => void checkForUpdates()}
    />
  );
}
