import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "../../../shared/contracts/shell";
import { SettingsLayout } from "../SettingsLayout";
import { LanguageSection } from "./LanguageSection";
import { StartupTraySection } from "./StartupTraySection";

const { changeLanguageMock, saveMock } = vi.hoisted(() => ({
  changeLanguageMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "language.title": "Dil",
        "language.description": "Uygulama dili",
        "language.options.en": "Ingilizce (ceviri)",
        "language.options.tr": "Turkce (ceviri)",
        "startupTray.title": "Baslangic ve Tepsi",
        "startupTray.launchAtLogin": "Giriste baslat",
        "startupTray.launchAtLoginDescription": "Acilista otomatik baslat",
        "startupTray.trayInfo": "Kapatinca tepside calisir",
        "startupTray.minimizeOnClose": "Kapatinca tepsiye kucult",
        "startupTray.alwaysOn": "Her zaman acik",
        "settings.sections.general": "Genel",
        "settings.sections.startupTray": "Baslangic ve Tepsi",
        "settings.sections.language": "Dil",
        "settings.sections.aboutLogs": "Hakkinda ve Gunlukler",
        "settings.sections.telemetry": "Telemetri",
        "settings.sections.device": "Cihaz",
        "settings.sections.calibration": "Kalibrasyon",
      };

      return dict[key] ?? key;
    },
    i18n: {
      language: "en",
    },
  }),
}));

vi.mock("../../i18n/i18n", () => ({
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  changeLanguage: changeLanguageMock,
}));

vi.mock("../../persistence/shellStore", () => ({
  shellStore: {
    save: saveMock,
  },
}));

vi.mock("../../tray/trayController", () => ({
  getStartupEnabled: vi.fn().mockResolvedValue(false),
  listenStartupToggle: vi.fn().mockResolvedValue(() => {}),
  setStartupTrayChecked: vi.fn().mockResolvedValue(undefined),
  toggleStartup: vi.fn().mockResolvedValue(true),
}));

describe("localized settings copy", () => {
  it("renders language option labels from locale keys", () => {
    render(<LanguageSection />);

    expect(screen.getByText("Ingilizce (ceviri)")).toBeInTheDocument();
    expect(screen.getByText("Turkce (ceviri)")).toBeInTheDocument();
  });

  it("renders startup tray static texts from locale keys", () => {
    render(<StartupTraySection />);

    expect(screen.getByText("Kapatinca tepsiye kucult")).toBeInTheDocument();
    expect(screen.getByText("Her zaman acik")).toBeInTheDocument();
  });

  it("keeps telemetry navigation label localized", () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.GENERAL}
        onSectionChange={vi.fn()}
        lightingMode={{ kind: "off" }}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onEditCalibration={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Telemetri/i })).toBeInTheDocument();
  });
});
