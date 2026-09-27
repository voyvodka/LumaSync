import { useCallback, useEffect, useState } from "react";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

type HueAreaChoiceSource = Pick<
  UseHueOnboardingResult,
  "selectedBridgeId" | "selectedAreaId" | "selectArea" | "refreshAreas" | "revalidateArea"
>;

export interface HueAreaChoice {
  /** The area list is open. */
  open: boolean;
  /** Opens the list (re-reading the areas) or closes it. */
  toggle: () => void;
  close: () => void;
  /** Switches to the area and checks it; the area in use only closes the list. */
  pick: (areaId: string) => void;
}

/**
 * The entertainment-area list. Picking is the choice: the list closes and the new area is checked.
 * Opening it re-reads the areas — `refreshAreas` keeps the saved area, so a list gated on "no
 * area yet" never reopened once one was chosen.
 */
export function useHueAreaChoice(hue: HueAreaChoiceSource, canChange: boolean): HueAreaChoice {
  const { selectedBridgeId, selectedAreaId, selectArea, refreshAreas, revalidateArea } = hue;
  const [open, setOpen] = useState(false);
  const [checkAfterSwitch, setCheckAfterSwitch] = useState<string | null>(null);

  // A state without the area row's control (the stream failed, the key was refused) or another
  // bridge takes the list down with it.
  const [bridgeId, setBridgeId] = useState(selectedBridgeId);
  if (bridgeId !== selectedBridgeId || (open && !canChange)) {
    setBridgeId(selectedBridgeId);
    setOpen(false);
  }

  // `revalidateArea` reads the selection it was built with, so the check waits for the render
  // that carries the new area.
  useEffect(() => {
    if (checkAfterSwitch === null || selectedAreaId !== checkAfterSwitch) return;
    setCheckAfterSwitch(null);
    void revalidateArea();
  }, [checkAfterSwitch, selectedAreaId, revalidateArea]);

  const toggle = useCallback(() => {
    if (!open) void refreshAreas();
    setOpen(!open);
  }, [open, refreshAreas]);

  const close = useCallback(() => setOpen(false), []);

  const pick = useCallback(
    (areaId: string) => {
      setOpen(false);
      if (areaId === selectedAreaId) return;
      selectArea(areaId);
      setCheckAfterSwitch(areaId);
    },
    [selectedAreaId, selectArea],
  );

  return { open, toggle, close, pick };
}
