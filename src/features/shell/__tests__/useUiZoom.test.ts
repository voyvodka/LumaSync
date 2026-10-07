import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests } from "@/features/persistence/preferences";

import { useUiZoom } from "../useUiZoom";

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: () => Promise.resolve() },
}));
vi.mock("../windowLifecycle", () => ({ windowLifecycleSettled: () => Promise.resolve() }));
vi.mock("../windowShellState", () => ({ loadShellState: () => Promise.resolve({ uiMode: "full" }) }));
vi.mock("../windowAnimator", () => ({ framedUiZoom: () => 1, resizeToMode: () => Promise.resolve() }));

const chromeScale = () => document.documentElement.style.getPropertyValue("--lm-chrome-scale");

describe("useUiZoom chrome scale", () => {
  beforeEach(() => {
    __resetPreferencesForTests();
    document.documentElement.style.removeProperty("--lm-chrome-scale");
  });
  afterEach(cleanup);

  it("undoes the stored interface size for the title bar from the first render", () => {
    __setPreferenceForTests("uiZoom", 125);
    renderHook(() => useUiZoom());
    expect(chromeScale()).toBe("0.8");
  });

  it("follows a change of the interface size", () => {
    renderHook(() => useUiZoom());
    expect(chromeScale()).toBe("1");
    act(() => __setPreferenceForTests("uiZoom", 90));
    expect(Number(chromeScale())).toBeCloseTo(100 / 90);
  });
});
