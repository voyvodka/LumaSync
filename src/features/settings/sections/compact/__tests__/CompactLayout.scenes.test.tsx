// The compact scene tiles showed the active scene only through an `is-on`
// class, where the Lights page's tiles already said it with aria-pressed.

import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SCENE_PRESETS } from "@/features/mode/model/scenePresets";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { SECTION_IDS } from "@/shared/contracts/shell";
import { SettingsLayout } from "../../../SettingsLayout";
import { renderWithShellStores } from "@/test/shellProviders";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
  },
}));

const [movie, other] = SCENE_PRESETS;

async function renderCompact(lightingMode: LightingModeConfig) {
  await act(async () => {
    renderWithShellStores(<SettingsLayout />, {
      hue: { configured: true, reachable: true, probeVerdict: "reachable" },
      navigation: { uiMode: "compact", activeSection: SECTION_IDS.LIGHTS },
      lighting: { lightingMode, outputTargets: ["hue"], localSink: null, bootstrapDone: true },
    });
  });
}

describe("CompactLayout scene tiles", () => {
  it("press the tile whose colour is the running solid colour, and only it", async () => {
    await renderCompact({
      kind: "solid",
      solid: { r: movie!.r, g: movie!.g, b: movie!.b, brightness: 0.5 },
    });
    expect(screen.getByRole("button", { name: movie!.labelKey })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: other!.labelKey })).toHaveAttribute("aria-pressed", "false");
  });

  it("press none while the lights are off", async () => {
    await renderCompact({ kind: "off" });
    for (const preset of SCENE_PRESETS) {
      expect(screen.getByRole("button", { name: preset.labelKey })).toHaveAttribute("aria-pressed", "false");
    }
  });
});
