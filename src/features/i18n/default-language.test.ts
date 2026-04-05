/**
 * default-language.test.ts
 *
 * Automated proof for I18N-02: first-launch default (English) and
 * persisted language override.
 *
 * Tests are mocked to avoid invoking the full Tauri plugin-store runtime.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the persistence layer so tests don't require a running Tauri runtime
// ---------------------------------------------------------------------------

vi.mock("../persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
  },
}));

import { shellStore } from "../persistence/shellStore";
import { resolveInitialLanguage } from "./languagePolicy";

describe("resolveInitialLanguage()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: first-launch — returns 'en' when no language is persisted (I18N-02)", async () => {
    // Arrange: simulate first launch — store has no language key (undefined)
    vi.mocked(shellStore.load).mockResolvedValue({
      windowWidth: 900,
      windowHeight: 620,
      windowX: null,
      windowY: null,
      lastSection: "lights",
      trayHintShown: false,
      startupEnabled: false,
      // language is absent (first launch state) — cast to satisfy TS in tests
      language: undefined as unknown as string,
    });

    // Act
    const result = await resolveInitialLanguage();

    // Assert
    expect(result).toBe("en");
  });

  it("Test 2: persisted language — returns stored language code when one exists", async () => {
    // Arrange: simulate returning user with 'tr' saved
    vi.mocked(shellStore.load).mockResolvedValue({
      windowWidth: 900,
      windowHeight: 620,
      windowX: null,
      windowY: null,
      lastSection: "lights",
      trayHintShown: false,
      startupEnabled: false,
      language: "tr",
    });

    // Act
    const result = await resolveInitialLanguage();

    // Assert
    expect(result).toBe("tr");
  });

  it("Test 3: unknown locale falls back to 'en' (I18N-02 fallback)", async () => {
    // Arrange: simulate corrupt or unsupported locale in store
    vi.mocked(shellStore.load).mockResolvedValue({
      windowWidth: 900,
      windowHeight: 620,
      windowX: null,
      windowY: null,
      lastSection: "lights",
      trayHintShown: false,
      startupEnabled: false,
      language: "xx-UNKNOWN",
    });

    // Act
    const result = await resolveInitialLanguage();

    // Assert — unknown locale not in supported list, policy falls back to 'en'
    expect(result).toBe("en");
  });

  it("Test 4: storage load failure falls back to 'en'", async () => {
    // Arrange: simulate persistence layer load error
    vi.mocked(shellStore.load).mockRejectedValue(new Error("store unavailable"));

    // Act
    const result = await resolveInitialLanguage();

    // Assert
    expect(result).toBe("en");
  });
});
