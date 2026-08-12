import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MODE_GUARD_REASONS } from "@/features/mode/state/modeGuard";
import type { LightingModeConfig } from "@/features/mode/model/contracts";
import { LightsSection } from "../LightsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "lights:mode.off.title": "Off",
        "lights:mode.off.subtitle": "Outputs parked",
        "lights:mode.ambilight.title": "Ambilight",
        "lights:mode.ambilight.subtitleFallback": "Live screen capture",
        "lights:mode.solid.title": "Solid",
        "lights:calibrationBanner.title": "Calibration required",
        "lights:calibrationBanner.sub": "Finish LED layout before enabling this mode.",
        "lights:calibrationBanner.action": "Open calibration",
        "lights:dock.outputs": "Outputs",
        "lights:dock.rows.usbName": "USB",
        "lights:dock.rows.usbType": "CH340",
        "lights:dock.rows.hueName": "HUE",
        "lights:dock.rows.hueType": "ENTERTAINMENT",
        "lights:dock.rows.hueSubIdle": "Bridge · standby",
        "common:mode.brightness": "Brightness",
        "common:mode.solidColor": "Solid color",
        "common:ui.colorPicker.hexLabel": "HEX",
        "common:ui.colorPicker.rootAriaLabel": "Color picker",
        "common:ui.colorPicker.hueLabel": "Hue",
        "common:ui.colorPicker.svLabel": "Saturation and value",
        "common:ui.colorPicker.recentColors": "Recent",
        "common:ui.colorPicker.recentItemAriaLabel": "Recent colour {{hex}}",
      };

      let value = dict[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

describe("LightsSection", () => {
  it("calls onModeChange with ambilight payload when Ambilight is selected", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Ambilight/ }));

    expect(onModeChange).toHaveBeenCalledWith({
      kind: "ambilight",
      ambilight: { brightness: 1, blackBorderDetection: false, smoothingAlpha: 0.35, saturation: 1 },
    } satisfies LightingModeConfig);
  });

  it("updates solid payload when color is changed in solid mode", async () => {
    const onModeChange = vi.fn();

    function Harness() {
      const [mode, setMode] = useState<LightingModeConfig>({
        kind: "solid",
        solid: { r: 255, g: 255, b: 255, brightness: 1 },
      });

      return (
        <LightsSection
          mode={mode}
          outputTargets={["usb"]}
          usbConnected={true}
          hueConfigured={false}
          hueStreaming={false}
          modeLockReason={null}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            onModeChange(nextMode);
          }}
          onOutputTargetsChange={vi.fn()}
          onOpenCalibration={vi.fn()}
        />
      );
    }

    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Brightness"), {
      target: { value: "35" },
    });
    // v1.5 W1-A7: solid colour picker migrated from native <input type="color">
    // to the SVG-native HsvColorPicker. Drive the change through the picker's
    // hex text input — value setter + Enter triggers commitHexDraft.
    const hexInput = screen.getByLabelText("HEX");
    fireEvent.change(hexInput, { target: { value: "#00ff00" } });
    fireEvent.keyDown(hexInput, { key: "Enter" });

    await waitFor(() => {
      expect(onModeChange).toHaveBeenLastCalledWith({
        kind: "solid",
        solid: { r: 0, g: 255, b: 0, brightness: 0.35 },
      } satisfies LightingModeConfig);
    });
  });

  it("keeps controls disabled and opens calibration CTA when lock reason is CALIBRATION_REQUIRED", async () => {
    const user = userEvent.setup();
    const onOpenCalibration = vi.fn();
    const onModeChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={MODE_GUARD_REASONS.CALIBRATION_REQUIRED}
        onModeChange={onModeChange}
        onOutputTargetsChange={vi.fn()}
        onOpenCalibration={onOpenCalibration}
      />,
    );

    expect(screen.getByRole("button", { name: /Ambilight/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Solid/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Open calibration" }));

    expect(onOpenCalibration).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("toggles hue target when hue is configured and the row is clicked", async () => {
    const user = userEvent.setup();
    const onOutputTargetsChange = vi.fn();

    render(
      <LightsSection
        mode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={true}
        hueStreaming={false}
        modeLockReason={null}
        onModeChange={vi.fn()}
        onOutputTargetsChange={onOutputTargetsChange}
        onOpenCalibration={vi.fn()}
      />,
    );

    // Hue is configured but not selected — clicking adds it
    await user.click(screen.getByRole("button", { name: /HUE/ }));

    expect(onOutputTargetsChange).toHaveBeenCalledWith(["usb", "hue"]);
  });
});
