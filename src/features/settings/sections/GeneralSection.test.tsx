import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MODE_GUARD_REASONS } from "../../mode/state/modeGuard";
import type { LightingModeConfig } from "../../mode/model/contracts";
import { GeneralSection } from "./GeneralSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "general.title": "General",
        "general.description": "General application settings.",
        "general.mode.title": "Lighting mode",
        "general.mode.description": "Select output mode.",
        "general.mode.options.off": "Off",
        "general.mode.options.ambilight": "Ambilight",
        "general.mode.options.solid": "Solid",
        "general.mode.brightness": "Brightness",
        "general.mode.solidColor": "Solid color",
        "general.mode.lockedReasonCalibration": "Complete calibration before enabling LED mode.",
        "general.mode.openCalibration": "Open calibration",
      };

      return dict[key] ?? key;
    },
  }),
}));

describe("GeneralSection", () => {
  it("calls onModeChange with ambilight payload when Ambilight is selected", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <GeneralSection
        mode={{ kind: "off" }}
        modeLockReason={null}
        onModeChange={onModeChange}
        onOpenCalibrationOverlay={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ambilight" }));

    expect(onModeChange).toHaveBeenCalledWith({
      kind: "ambilight",
      ambilight: { brightness: 1 },
    } satisfies LightingModeConfig);
  });

  it("updates solid payload when color is changed in solid mode", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <GeneralSection
        mode={{ kind: "solid", solid: { r: 255, g: 255, b: 255, brightness: 1 } }}
        modeLockReason={null}
        onModeChange={onModeChange}
        onOpenCalibrationOverlay={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("Brightness"));
    await user.type(screen.getByLabelText("Brightness"), "0.35");
    await user.clear(screen.getByLabelText("Solid color"));
    await user.type(screen.getByLabelText("Solid color"), "#00ff00");

    expect(onModeChange).toHaveBeenCalledWith({
      kind: "solid",
      solid: { r: 0, g: 255, b: 0, brightness: 0.35 },
    } satisfies LightingModeConfig);
  });

  it("keeps controls disabled and opens calibration CTA when lock reason is CALIBRATION_REQUIRED", async () => {
    const user = userEvent.setup();
    const onOpenCalibrationOverlay = vi.fn();
    const onModeChange = vi.fn();

    render(
      <GeneralSection
        mode={{ kind: "off" }}
        modeLockReason={MODE_GUARD_REASONS.CALIBRATION_REQUIRED}
        onModeChange={onModeChange}
        onOpenCalibrationOverlay={onOpenCalibrationOverlay}
      />,
    );

    expect(screen.getByRole("button", { name: "Ambilight" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Solid" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Open calibration" }));

    expect(onOpenCalibrationOverlay).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
