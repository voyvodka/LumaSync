import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests } from "@/features/persistence/preferences";
import type { UiZoom } from "@/shared/contracts/shell";

import { useUiZoom } from "../useUiZoom";

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: () => Promise.resolve() },
}));

const chromeScale = () => document.documentElement.style.getPropertyValue("--lm-chrome-scale");

describe("useUiZoom", () => {
  beforeEach(() => {
    __resetPreferencesForTests();
    document.documentElement.style.removeProperty("--lm-chrome-scale");
  });
  afterEach(cleanup);

  it("undoes the stored interface size for the title bar from the first render", () => {
    __setPreferenceForTests("uiZoom", 125);
    renderHook(() => useUiZoom({ onZoom: vi.fn<(zoom: UiZoom) => void>() }));
    expect(chromeScale()).toBe("0.8");
  });

  it("hands a new size to the transition rather than applying it on the spot", () => {
    const onZoom = vi.fn<(zoom: UiZoom) => void>();
    renderHook(() => useUiZoom({ onZoom }));
    act(() => __setPreferenceForTests("uiZoom", 90));
    expect(onZoom).toHaveBeenCalledWith(90);
    // The counter-scale lands with the webview zoom inside the fade, not before it.
    expect(chromeScale()).toBe("1");
  });
});
