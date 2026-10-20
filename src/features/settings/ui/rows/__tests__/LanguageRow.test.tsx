import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const i18n = vi.hoisted(() => ({ language: "en" }));
const changeLanguage = vi.hoisted(() => vi.fn<(lang: string) => Promise<void>>());
const save = vi.hoisted(() => vi.fn<(partial: Record<string, unknown>) => Promise<void>>());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n }),
}));
vi.mock("@/features/i18n/i18n", () => ({
  changeLanguage,
  I18N_SUPPORTED_LANGUAGES: ["en", "tr"],
  I18N_LANGUAGE_NAMES: { en: "English", tr: "Türkçe" },
}));
vi.mock("@/features/persistence/shellStore", () => ({ shellStore: { save } }));
vi.mock("@/features/tray/trayController", () => ({
  getStartupEnabled: vi.fn<() => Promise<boolean>>(),
  setStartup: vi.fn<(enabled: boolean) => Promise<void>>(),
}));

import { LanguageRow } from "../GeneralRows";

beforeEach(() => {
  i18n.language = "en";
  changeLanguage.mockReset().mockResolvedValue(undefined);
  save.mockReset().mockResolvedValue(undefined);
});

describe("LanguageRow", () => {
  it("shows both languages, each in its own words, the one in use chosen", () => {
    render(<LanguageRow />);
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Türkçe" })).toHaveAttribute("aria-checked", "false");
  });

  it("switches and saves the choice; the language in use asks for nothing", async () => {
    render(<LanguageRow />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "English" })));
    expect(changeLanguage).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Türkçe" })));
    expect(changeLanguage).toHaveBeenCalledWith("tr");
    expect(save).toHaveBeenCalledWith({ language: "tr" });
  });
});
