import { describe, expect, it } from "vitest";

import enCommon from "../../locales/en/common.json";
import trCommon from "../../locales/tr/common.json";

function assertLocaleKeyParity(_enLocale: unknown, _trLocale: unknown) {
  throw new Error("Not implemented");
}

describe("locale key parity", () => {
  it("keeps EN and TR locale key trees in parity", () => {
    expect(() => assertLocaleKeyParity(enCommon, trCommon)).not.toThrow();
  });

  it("reports missing keys in both directions when trees drift", () => {
    const enFixture = {
      settings: {
        title: "Settings",
      },
      telemetry: {
        title: "Runtime telemetry",
      },
    };

    const trFixture = {
      settings: {
        title: "Ayarlar",
        description: "Uygulama ayarlari",
      },
      startupTray: {
        title: "Baslangic ve Tepsi",
      },
    };

    expect(() => assertLocaleKeyParity(enFixture, trFixture)).toThrowError(
      /missing-in-en:\s*\["settings.description", "startupTray.title"\].*missing-in-tr:\s*\["telemetry.title"\]/s,
    );
  });
});
