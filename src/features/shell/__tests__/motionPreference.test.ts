import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";

const { savedListeners } = vi.hoisted(() => ({
  savedListeners: new Set<(saved: Partial<ShellState>) => void>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
    onSaved: (listener: (saved: Partial<ShellState>) => void) => {
      savedListeners.add(listener);
      return () => savedListeners.delete(listener);
    },
  },
}));

import { __resetPreferencesForTests } from "@/features/persistence/preferences";
import { followMotionPreference } from "../motionPreference";

const reduced = () => document.documentElement.hasAttribute("data-reduced-motion");

describe("followMotionPreference", () => {
  afterEach(() => {
    __resetPreferencesForTests();
    document.documentElement.removeAttribute("data-reduced-motion");
  });

  it("applies the boot read before anything awaiting the same read runs, then follows other windows", async () => {
    const boot = Promise.resolve({ motion: "reduce" } as ShellState);
    followMotionPreference(boot);
    await boot;

    expect(reduced()).toBe(true);

    for (const listener of savedListeners) listener({ motion: "system" });
    expect(reduced()).toBe(false);
  });
});
