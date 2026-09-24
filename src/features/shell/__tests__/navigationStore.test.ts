import { describe, expect, it, vi } from "vitest";

import { SECTION_IDS } from "@/shared/contracts/shell";

import { createNavigationStore } from "../navigationStore";

describe("createNavigationStore", () => {
  it("opens on Lights in compact, with no category asked for", () => {
    expect(createNavigationStore().get()).toEqual({
      uiMode: "compact",
      activeSection: SECTION_IDS.LIGHTS,
      deviceCategoryRequest: null,
    });
  });

  it("writes a notice's section and category together, and a repeat of it counts again", () => {
    const store = createNavigationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.openSection(SECTION_IDS.DEVICES, "hue");
    expect(listener).toHaveBeenCalledTimes(1);
    const first = store.get().deviceCategoryRequest;
    expect(store.get().activeSection).toBe(SECTION_IDS.DEVICES);
    expect(first?.category).toBe("hue");

    store.openSection(SECTION_IDS.DEVICES, "hue");
    expect(store.get().deviceCategoryRequest).not.toBe(first);
  });

  it("clears the category on any other way in, and keeps it on a plain section set", () => {
    const store = createNavigationStore();
    store.openSection(SECTION_IDS.DEVICES, "wled");

    store.setActiveSection(SECTION_IDS.SYSTEM);
    expect(store.get().deviceCategoryRequest?.category).toBe("wled");

    store.openSection(SECTION_IDS.DEVICES);
    expect(store.get().deviceCategoryRequest).toBeNull();
  });

  it("does not notify for a write that changes nothing", () => {
    const store = createNavigationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveSection(SECTION_IDS.LIGHTS);
    store.setUIMode("compact");
    store.openSection(SECTION_IDS.LIGHTS);
    expect(listener).not.toHaveBeenCalled();

    store.setUIMode("full");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
