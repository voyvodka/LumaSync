import { afterEach, describe, expect, it, vi } from "vitest";

function stubOs(reduce: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduce,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

async function fresh() {
  vi.resetModules();
  return import("../motion");
}

describe("reduced motion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-reduced-motion");
  });

  it("puts the attribute on the root when Settings asks, and takes it off when it stops", async () => {
    stubOs(false);
    const { applyReducedMotion, prefersReducedMotion } = await fresh();

    applyReducedMotion(true);
    expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(true);
    expect(prefersReducedMotion()).toBe(true);

    applyReducedMotion(false);
    expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("keeps the OS request whatever Settings says, and follows it live", async () => {
    const os = stubOs(true);
    const { applyReducedMotion } = await fresh();

    applyReducedMotion(false);
    expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(true);

    os.set(false);
    expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(false);
  });
});
