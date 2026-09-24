import { useCallback, useEffect, useState } from "react";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

type HueAreaChoiceSource = Pick<
  UseHueOnboardingResult,
  "selectedBridgeId" | "selectedAreaId" | "selectArea" | "refreshAreas" | "revalidateArea"
>;

export interface HueAreaChoice {
  /** "Change area" opened the list over a card that already has an area. */
  changing: boolean;
  /** The highlighted area: the user's pick, else the area in use. */
  draftId: string | null;
  start: () => void;
  pick: (areaId: string) => void;
  /** Switches to the draft and checks it; the area in use only closes the list. */
  confirm: () => void;
  /** Closes the list; the area in use never changed. */
  cancel: () => void;
}

/**
 * The entertainment-area list's pending choice. Picking only highlights; the
 * area changes on Confirm. `refreshAreas` keeps the saved area, so a list
 * gated on "no area yet" never reopened once one was chosen.
 */
export function useHueAreaChoice(hue: HueAreaChoiceSource, canChange: boolean): HueAreaChoice {
  const { selectedBridgeId, selectedAreaId, selectArea, refreshAreas, revalidateArea } = hue;
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [checkAfterSwitch, setCheckAfterSwitch] = useState<string | null>(null);

  // A card state without "Change area" (the stream failed, the key was
  // refused) or another bridge takes the list down with it.
  const [bridgeId, setBridgeId] = useState(selectedBridgeId);
  if (bridgeId !== selectedBridgeId || (changing && !canChange)) {
    setBridgeId(selectedBridgeId);
    setChanging(false);
    setDraft(null);
  }

  // `revalidateArea` reads the selection it was built with, so the check
  // waits for the render that carries the new area.
  useEffect(() => {
    if (checkAfterSwitch === null || selectedAreaId !== checkAfterSwitch) return;
    setCheckAfterSwitch(null);
    void revalidateArea();
  }, [checkAfterSwitch, selectedAreaId, revalidateArea]);

  const draftId = draft ?? selectedAreaId;

  const start = useCallback(() => {
    setDraft(null);
    setChanging(true);
    void refreshAreas();
  }, [refreshAreas]);

  const confirm = useCallback(() => {
    setChanging(false);
    setDraft(null);
    if (draftId === null || draftId === selectedAreaId) return;
    selectArea(draftId);
    setCheckAfterSwitch(draftId);
  }, [draftId, selectedAreaId, selectArea]);

  const cancel = useCallback(() => {
    setChanging(false);
    setDraft(null);
  }, []);

  return { changing, draftId, start, pick: setDraft, confirm, cancel };
}
