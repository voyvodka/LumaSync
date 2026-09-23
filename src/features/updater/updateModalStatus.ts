import type { UpdaterState } from "./useAutoUpdater";

/** The statuses `UpdateModal` draws a dialog for; `idle` and `checking` draw nothing. */
export function isUpdateModalStatus(state: UpdaterState): boolean {
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "installing" ||
    state.status === "error"
  );
}
