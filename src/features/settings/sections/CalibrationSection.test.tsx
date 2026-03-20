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
        onOpenCalibration={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Calibration" })).toBeInTheDocument();
  });

  it("shows template label and not calibrated fallback summary", () => {
    const onEdit = vi.fn();

    const { rerender } = render(
      <CalibrationSection
        calibration={{
          templateId: "monitor-27-16-9",
          counts: { top: 36, left: 22, right: 22, bottomLeft: 17, bottomRight: 17 },
          bottomGapPx: 140,
          startAnchor: "top-start",
          direction: "cw",
          totalLeds: 114,
        }}
        onEdit={onEdit}
      />, 
    );

    expect(screen.getByText('27" 16:9')).toBeInTheDocument();
    expect(screen.getByText("114")).toBeInTheDocument();

    rerender(<CalibrationSection calibration={undefined} onEdit={onEdit} />);

    expect(screen.getByText("Not calibrated")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("calls edit callback when edit button is clicked", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(<CalibrationSection onEdit={onEdit} />);

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledOnce();
  });
});
