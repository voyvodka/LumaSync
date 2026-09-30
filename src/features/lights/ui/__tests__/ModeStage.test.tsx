import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setSceneEdit } from "@/features/scenes/state/scenesStore";
import type { LightingModeConfig } from "@/shared/contracts/mode";

import { ModeStage } from "../ModeStage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const WAVE: LightingModeConfig = { kind: "effect", effect: { id: "wave", speed: 0.5, brightness: 1 } };

function renderStage(dense = false) {
  render(
    <ModeStage
      mode={WAVE}
      dense={dense}
      disabled={false}
      brightnessLocked={false}
      onModeChange={() => {}}
      lastLit="effect"
    />,
  );
}

const galleryBox = () => screen.getByRole("radiogroup", { name: "lights:effect.label" }).parentElement!;

afterEach(() => {
  cleanup();
  setSceneEdit(null);
});

describe("ModeStage while a scene is edited", () => {
  it("folds the effect gallery to one row, so the settings being shaped sit near the top", () => {
    renderStage();
    expect(galleryBox()).not.toHaveAttribute("data-row");
    act(() => setSceneEdit({ sceneId: null, name: "", before: { mode: WAVE, smoothing: "moderate" } }));
    expect(galleryBox()).toHaveAttribute("data-row");
    act(() => setSceneEdit(null));
    expect(galleryBox()).not.toHaveAttribute("data-row");
  });

  it("leaves the compact window's picker as it is", () => {
    setSceneEdit({ sceneId: null, name: "", before: { mode: WAVE, smoothing: "moderate" } });
    renderStage(true);
    expect(screen.getByTestId("effect-picker")).toBeInTheDocument();
    expect(screen.queryByTestId("effect-wave")).toBeNull();
  });
});
