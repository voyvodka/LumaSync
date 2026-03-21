import { describe, expect, it } from "vitest";

import enCommon from "../../locales/en/common.json";
import trCommon from "../../locales/tr/common.json";

function flattenKeys(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return prefix ? [prefix] : [];
  }

  const entries = Object.entries(node as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  if (entries.length === 0) {
    return prefix ? [prefix] : [];
  }

  return entries.flatMap(([key, value]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;

    return flattenKeys(value, nextPrefix);
  });
}

function assertLocaleKeyParity(enLocale: unknown, trLocale: unknown) {
  const enKeys = flattenKeys(enLocale);
  const trKeys = flattenKeys(trLocale);

  const enKeySet = new Set(enKeys);
  const trKeySet = new Set(trKeys);

  const missingInEn = trKeys.filter((key) => !enKeySet.has(key));
  const missingInTr = enKeys.filter((key) => !trKeySet.has(key));

  if (missingInEn.length === 0 && missingInTr.length === 0) {
    return;
  }

  throw new Error(
    [
      "Locale key parity drift detected.",
      `missing-in-en: ${JSON.stringify(missingInEn)}`,
      `missing-in-tr: ${JSON.stringify(missingInTr)}`,
    ].join("\n"),
  );
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
      /missing-in-en:\s*\["settings\.description","startupTray\.title"\].*missing-in-tr:\s*\["telemetry\.title"\]/s,
    );
  });
});
