import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
        "general.output.title": "Output targets",
        "general.output.devices.usb": "USB LED Strip",
        "general.output.devices.hue": "Philips Hue",
        "general.output.status.connected": "Connected",
        "general.output.status.notConnected": "Not connected",
        "general.output.status.ready": "Ready",
        "general.output.status.notConfigured": "Not configured",
        "general.output.noDevices": "No devices available",
        "general.output.noDevicesHint": "Connect your devices in Settings",
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

    await user.click(screen.getByRole("button", { name: "Ambilight" }));

    expect(onModeChange).toHaveBeenCalledWith({
      kind: "ambilight",
      ambilight: { brightness: 1 },
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
        <GeneralSection
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
    fireEvent.change(screen.getByLabelText("Solid color"), {
      target: { value: "#00ff00" },
    });

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
        <GeneralSection
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

    expect(screen.getByRole("button", { name: "Ambilight" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Solid" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Open calibration" }));

    expect(onOpenCalibration).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("toggles hue target when hue is configured and the row is clicked", async () => {
    const user = userEvent.setup();
    const onOutputTargetsChange = vi.fn();

    render(
      <GeneralSection
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
    await user.click(screen.getByRole("button", { name: /Philips Hue/i }));

    expect(onOutputTargetsChange).toHaveBeenCalledWith(["usb", "hue"]);
  });
});
