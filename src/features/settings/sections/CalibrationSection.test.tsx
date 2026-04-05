import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "../../../shared/contracts/shell";
import { SettingsLayout } from "../SettingsLayout";
import { CalibrationSection } from "./CalibrationSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "settings.sections.lights": "Lights",
        "settings.sections.led-setup": "LED Setup",
        "settings.sections.devices": "Devices",
        "settings.sections.system": "System",
        "calibration.section.title": "Calibration",
        "calibration.section.description": "Summary and edit entry",
        "calibration.section.template": "Template",
        "calibration.section.totalLeds": "Total LEDs",
        "calibration.section.edges": "Edge LEDs",
        "calibration.section.gap": "Bottom missing LEDs",
        "calibration.section.cornerOwnership": "Corner ownership",
        "calibration.section.cornerOwnershipHorizontal": "Horizontal edges",
        "calibration.section.cornerOwnershipVertical": "Vertical edges",
        "calibration.section.startAnchor": "Start anchor",
        "calibration.section.direction": "Direction",
        "calibration.editor.startAnchors.top-start": "Top edge - left corner",
        "calibration.editor.directions.cw": "Clockwise",
        "calibration.section.emptyState": "No calibration saved yet. Open the editor to map your strip before enabling live mode.",
        "calibration.section.notConfigured": "Not calibrated",
        "calibration.section.manual": "Manual",
        "calibration.section.edit": "Edit",
        "calibration.section.counts.top": "Top",
        "calibration.section.counts.right": "Right",
        "calibration.section.counts.bottom": "Bottom",
        "calibration.section.counts.left": "Left",
      };

      return dict[key] ?? key;
    },
  }),
}));

describe("CalibrationSection", () => {
  it("renders LED Setup navigation item in the layout", () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.LIGHTS}
        onSectionChange={vi.fn()}
        calibrationStep="editor"
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        usbConnected={true}
        hueConfigured={false}
        hueStreaming={false}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onCalibrationSaved={vi.fn()}
        onCalibrationStepChange={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
      />,
    );

    expect(screen.getByRole("button", { name: /LED Setup/i })).toBeInTheDocument();
  });

  it("shows template and geometry overview values when calibration is configured", () => {
    const onEditCalibration = vi.fn();

    render(
      <CalibrationSection
        calibration={{
          templateId: "monitor-27-16-9",
          counts: { top: 36, right: 22, bottom: 34, left: 22 },
          bottomMissing: 2,
          cornerOwnership: "horizontal",
          visualPreset: "vivid",
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 114,
        }}
        onEditCalibration={onEditCalibration}
      />,
    );

    expect(screen.getByText('27" 16:9')).toBeInTheDocument();
    expect(screen.getByText("114")).toBeInTheDocument();
    expect(screen.getByText("Top 36 • Right 22 • Bottom 34 • Left 22")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Horizontal edges")).toBeInTheDocument();
    expect(screen.getByText("Top edge - left corner")).toBeInTheDocument();
    expect(screen.getByText("Clockwise")).toBeInTheDocument();
  });

  it("shows a clear empty-state helper and edit action when calibration is missing", () => {
    const onEditCalibration = vi.fn();

    render(<CalibrationSection calibration={undefined} onEditCalibration={onEditCalibration} />);

    expect(screen.getAllByText("Not calibrated").length).toBeGreaterThan(0);
    expect(
      screen.getByText("No calibration saved yet. Open the editor to map your strip before enabling live mode."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("calls edit callback when edit button is clicked", async () => {
    const onEditCalibration = vi.fn();
    const user = userEvent.setup();

    render(<CalibrationSection onEditCalibration={onEditCalibration} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(onEditCalibration).toHaveBeenCalledOnce();
  });
});
