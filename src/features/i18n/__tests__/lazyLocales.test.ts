import { describe, expect, it } from "vitest";

import en from "@/locales/en";
import tr from "@/locales/tr";

import { changeLanguage, i18next, initI18n } from "../i18n";

// One i18next instance per file, so the steps run in order against it.
describe("locale catalogues load per language", () => {
  it("starts with only the active language's catalogue", async () => {
    await initI18n("tr");

    expect(i18next.hasResourceBundle("tr", "common")).toBe(true);
    expect(i18next.hasResourceBundle("en", "common")).toBe(false);
    expect(i18next.t("settings:language.label")).toBe(tr.settings.language.label);
    expect(document.documentElement.lang).toBe("tr");
  });

  it("loads the other catalogue before switching to it", async () => {
    await changeLanguage("en");

    expect(i18next.hasResourceBundle("en", "common")).toBe(true);
    expect(i18next.t("settings:language.label")).toBe(en.settings.language.label);
    expect(document.documentElement.lang).toBe("en");
  });
});
