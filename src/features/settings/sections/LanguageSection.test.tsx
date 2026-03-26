import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "../../../shared/contracts/shell";
import { SettingsLayout } from "../SettingsLayout";
import { LanguageSection } from "./LanguageSection";
import { StartupTraySection } from "./StartupTraySection";

const mocks = vi.hoisted(() => {
  let currentLanguage = "en";

  return {
    changeLanguageMock: vi.fn(async (lang: string) => {
      currentLanguage = lang;
    }),
    saveMock: vi.fn(),
    setLanguage: (lang: string) => {
      currentLanguage = lang;
    },
    getLanguage: () => currentLanguage,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => {
    const language = mocks.getLanguage().toLowerCase().startsWith("tr") ? "tr" : "en";

    const dictionaryByLanguage: Record<string, Record<string, string>> = {
      en: {
        "language.title": "Language",
        "language.description": "Application language",
        "language.options.en": "English",
        "language.options.tr": "Turkish",
        "startupTray.title": "Startup & Tray",
        "startupTray.launchAtLogin": "Launch at login",
        "startupTray.launchAtLoginDescription": "Start on boot",
        "startupTray.trayInfo": "Keeps running in tray",
        "startupTray.minimizeOnClose": "Minimize on close",
        "startupTray.alwaysOn": "Always on",
        "settings.sections.general": "General",
        "settings.sections.startupTray": "Startup & Tray",
        "settings.sections.language": "Language",
        "settings.sections.aboutLogs": "About & Logs",
        "settings.sections.telemetry": "Telemetry",
        "settings.sections.device": "Device",
        "settings.sections.calibration": "Calibration",
      },
      tr: {
        "language.title": "Dil",
        "language.description": "Uygulama dili",
        "language.options.en": "Ingilizce",
        "language.options.tr": "Turkce (TR secildi)",
        "startupTray.title": "Baslangic ve Tepsi",
        "startupTray.launchAtLogin": "Giriste baslat",
        "startupTray.launchAtLoginDescription": "Acilista baslat",
        "startupTray.trayInfo": "Tepside calismaya devam eder",
        "startupTray.minimizeOnClose": "Kapatinca tepsiye kucult",
        "startupTray.alwaysOn": "Her zaman acik",
        "settings.sections.general": "Genel",
        "settings.sections.startupTray": "Baslangic ve Tepsi",
        "settings.sections.language": "Dil",
        "settings.sections.aboutLogs": "Hakkinda ve Gunlukler",
        "settings.sections.telemetry": "Telemetri",
        "settings.sections.device": "Cihaz",
        "settings.sections.calibration": "Kalibrasyon",
      },
    };

    return {
      t: (key: string) => dictionaryByLanguage[language][key] ?? key,
      i18n: {
        language: mocks.getLanguage(),
      },
    };
  },
}));

vi.mock("../../i18n/i18n", () => ({
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  changeLanguage: mocks.changeLanguageMock,
}));

vi.mock("../../persistence/shellStore", () => ({
  shellStore: {
    save: mocks.saveMock,
  },
}));

vi.mock("../../tray/trayController", () => ({
  getStartupEnabled: vi.fn().mockResolvedValue(false),
  listenStartupToggle: vi.fn().mockResolvedValue(() => {}),
  setStartupTrayChecked: vi.fn().mockResolvedValue(undefined),
  toggleStartup: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  mocks.setLanguage("en");
  mocks.changeLanguageMock.mockClear();
  mocks.saveMock.mockClear();
});

describe("localized settings copy", () => {
  it("renders language option labels from locale keys", () => {
    render(<LanguageSection />);

    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Turkish")).toBeInTheDocument();
  });

  it("renders startup tray static texts from locale keys", async () => {
    render(<StartupTraySection />);

    expect(await screen.findByText("Minimize on close")).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
  });

  it("keeps settings navigation label localized", () => {
    render(
      <SettingsLayout
        activeSection={SECTION_IDS.CONTROL}
        onSectionChange={vi.fn()}
        calibrationStep="editor"
        lightingMode={{ kind: "off" }}
        outputTargets={["usb"]}
        modeLockReason={null}
        onLightingModeChange={vi.fn()}
        onOutputTargetsChange={vi.fn()}
        onCalibrationSaved={vi.fn()}
        onCheckForUpdates={vi.fn()}
        isCheckingForUpdates={false}
      />,
    );

    expect(screen.getByRole("button", { name: /Calibration/i })).toBeInTheDocument();
  });
});

describe("LanguageSection runtime change behavior", () => {
  it("calls changeLanguage and persists language when user selects a different language", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LanguageSection />);

    await user.click(screen.getByRole("radio", { name: /Turkish/i }));
    rerender(<LanguageSection />);

    expect(mocks.changeLanguageMock).toHaveBeenCalledWith("tr");
    expect(mocks.saveMock).toHaveBeenCalledWith({ language: "tr" });
    expect(screen.getByText("Turkce (TR secildi)")).toBeInTheDocument();
  });

  it("does not call changeLanguage or save when the same language is selected", async () => {
    const user = userEvent.setup();
    render(<LanguageSection />);

    await user.click(screen.getByRole("radio", { name: /English/i }));

    expect(mocks.changeLanguageMock).not.toHaveBeenCalled();
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });

  it("treats regional language codes as same base language and skips redundant updates", async () => {
    const user = userEvent.setup();
    mocks.setLanguage("en-US");
    render(<LanguageSection />);

    await user.click(screen.getByRole("radio", { name: /English/i }));

    expect(mocks.changeLanguageMock).not.toHaveBeenCalled();
    expect(mocks.saveMock).not.toHaveBeenCalled();
  });
});
