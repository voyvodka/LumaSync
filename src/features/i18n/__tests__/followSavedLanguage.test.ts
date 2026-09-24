// The control popup is hidden and reused, never rebuilt: it must follow the
// language the user picks in Settings instead of keeping the one it was built in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";

const { savedListeners, changeLanguageMock, i18nState } = vi.hoisted(() => ({
  savedListeners: new Set<(saved: Partial<ShellState>) => void>(),
  changeLanguageMock: vi.fn<(lang: string) => Promise<void>>(),
  i18nState: { language: "en" },
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn<() => Promise<unknown>>(),
    onSaved: (listener: (saved: Partial<ShellState>) => void) => {
      savedListeners.add(listener);
      return () => savedListeners.delete(listener);
    },
  },
}));

vi.mock("../i18n", () => ({
  changeLanguage: (lang: string) => changeLanguageMock(lang),
  i18next: i18nState,
}));

import { followSavedLanguage } from "../languagePolicy";

function saved(partial: Partial<ShellState>) {
  for (const listener of savedListeners) listener(partial);
}

describe("followSavedLanguage", () => {
  beforeEach(() => {
    savedListeners.clear();
    changeLanguageMock.mockReset().mockResolvedValue(undefined);
    i18nState.language = "en";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches to a language another window saved", () => {
    followSavedLanguage();
    saved({ language: "tr" });
    expect(changeLanguageMock).toHaveBeenCalledWith("tr");
  });

  it("ignores saves that do not touch the language, and the language already shown", () => {
    followSavedLanguage();
    saved({ showNerdStats: true });
    saved({ language: "en" });
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it("ignores a language it has no catalogue for", () => {
    followSavedLanguage();
    saved({ language: "de" });
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it("logs a switch that failed instead of dropping it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    changeLanguageMock.mockRejectedValue(new Error("chunk failed"));
    followSavedLanguage();
    saved({ language: "tr" });
    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
  });

  it("stops following once unsubscribed", () => {
    const stop = followSavedLanguage();
    stop();
    saved({ language: "tr" });
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });
});
