// Effect ran in compact with nothing under the mode strip: no name, no speed, no brightness.

import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

describe("LightsCompact — Effect", () => {
  it("shows the running effect, its palettes, speed and brightness", async () => {
    await act(async () => {
      renderWithShellStores(<SettingsLayout />, {
        hue: { configured: true, reachable: true, probeVerdict: "reachable" },
        navigation: { uiMode: "compact", activeSection: SECTION_IDS.LIGHTS },
        lighting: {
          lightingMode: { kind: "effect", effect: { id: "candle", speed: 0.4, brightness: 0.7 } },
          outputTargets: ["hue"],
          localSink: null,
          bootstrapDone: true,
        },
      });
    });

    expect(screen.getByTestId("effect-picker")).toHaveTextContent("lights:effect.names.candle");
    expect(screen.getByTestId("palette-custom")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("effect-speed")).toHaveValue("40");
    expect(screen.getByTestId("effect-brightness")).toHaveValue("70");
  });
});
