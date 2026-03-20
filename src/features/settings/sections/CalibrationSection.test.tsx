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
        "settings.sections.general": "General",
        "settings.sections.startupTray": "Startup & Tray",
        "settings.sections.language": "Language",
        "settings.sections.aboutLogs": "About & Logs",
        "settings.sections.device": "Device",
        "settings.sections.calibration": "Calibration",
        "calibration.section.title": "Calibration",
        "calibration.section.description": "Summary and edit entry",
        "calibration.section.template": "Template",
        "calibration.section.totalLeds": "Total LEDs",
        "calibration.section.edges": "Edge LEDs",
        "calibration.section.gap": "Bottom gap",
        "calibration.section.startAnchor": "Start anchor",
        "calibration.section.direction": "Direction",
        "calibration.section.emptyState": "No calibration saved yet. Open the editor to map your strip before enabling live mode.",
        "calibration.section.notConfigured": "Not calibrated",
        "calibration.section.manual": "Manual",
        "calibration.section.edit": "Edit",
      };

      return dict[key] ?? key;
    },
  }),
}));

describe("CalibrationSection", () => {
  it("renders CalibrationSection content in settings when calibration sidebar section is active", () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.CALIBRATION}
        onSectionChange={vi.fn()}
        ledModeEnabled={false}
        modeLockReason={null}
        onLedModeChange={vi.fn()}
        onEditCalibration={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Calibration" })).toBeInTheDocument();
  });

  it("shows template and geometry overview values when calibration is configured", () => {
    const onEditCalibration = vi.fn();

    render(
      <CalibrationSection
        calibration={{
          templateId: "monitor-27-16-9",
          counts: { top: 36, left: 22, right: 22, bottomLeft: 17, bottomRight: 17 },
          bottomGapPx: 140,
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 114,
        }}
        onEditCalibration={onEditCalibration}
      />,
    );

    expect(screen.getByText('27" 16:9')).toBeInTheDocument();
    expect(screen.getByText("114")).toBeInTheDocument();
    expect(screen.getByText("Top 36 • Right 22 • Bottom right 17 • Bottom left 17 • Left 22")).toBeInTheDocument();
    expect(screen.getByText("140 px")).toBeInTheDocument();
    expect(screen.getByText("top-start")).toBeInTheDocument();
    expect(screen.getByText("CW")).toBeInTheDocument();
  });

  it("shows a clear empty-state helper and edit action when calibration is missing", () => {
    const onEditCalibration = vi.fn();

    render(<CalibrationSection calibration={undefined} onEditCalibration={onEditCalibration} />);

    expect(screen.getByText("Not calibrated")).toBeInTheDocument();
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
