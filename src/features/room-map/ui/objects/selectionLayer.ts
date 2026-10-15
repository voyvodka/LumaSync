import { createContext, useContext } from "react";

/** The plan's layer above every object, where a selected piece draws its frame and handles. */
export const SelectionLayerContext = createContext<HTMLDivElement | null>(null);

export function useSelectionLayer(): HTMLDivElement | null {
  return useContext(SelectionLayerContext);
}
