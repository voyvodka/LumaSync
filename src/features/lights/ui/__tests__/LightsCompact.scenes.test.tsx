// The compact window shows the same scenes as Lights: the running look is the checked chip, and a
// press applies the whole scene, Solid carrying the saved targets like every Solid choice there.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetScenesForTests } from "@/features/scenes/state/scenesStore";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { SettingsLayout } from "@/features/settings/SettingsLayout";
import { renderWithShellStores } from "@/test/shellProviders";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
    onSaved: () => () => {},
  },
}));

const WARM_EVENING = "lights:scenes.suggested.warmEvening";

async function renderCompact(lightingMode: LightingModeConfig) {
  const changeMode = vi.fn<(next: LightingModeConfig) => void>();
  await act(async () => {
    renderWithShellStores(<SettingsLayout />, {
      hue: { configured: true, reachable: true, probeVerdict: "reachable" },
      navigation: { uiMode: "compact", activeSection: SECTION_IDS.LIGHTS },
      lighting: { lightingMode, outputTargets: ["hue"], localSink: null, bootstrapDone: true },
      lightingActions: { changeMode },
    });
  });
  return changeMode;
}

// Unmounted first: a reset under a mounted row would re-render it outside act.
afterEach(() => {
  cleanup();
  __resetScenesForTests();
});

describe("LightsCompact scenes", () => {
  it("checks the scene whose look is running, and only it", async () => {
    await renderCompact({ kind: "solid", solid: { r: 255, g: 180, b: 107, brightness: 0.55, kelvin: 2700 } });
    expect(screen.getByRole("radio", { name: WARM_EVENING })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "lights:scenes.suggested.reading" })).toHaveAttribute("aria-checked", "false");
  });

  it("checks none while the lights are off", async () => {
    await renderCompact({ kind: "off" });
    for (const chip of screen.getAllByRole("radio", { name: /lights:scenes\.suggested/ })) {
      expect(chip).toHaveAttribute("aria-checked", "false");
    }
  });

  it("applies a Solid scene with the saved targets", async () => {
    const changeMode = await renderCompact({ kind: "off" });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: WARM_EVENING }));
    });
    expect(changeMode).toHaveBeenCalledWith({
      kind: "solid",
      solid: expect.objectContaining({ kelvin: 2700, brightness: 0.55 }),
      targets: ["hue"],
    });
  });
});
