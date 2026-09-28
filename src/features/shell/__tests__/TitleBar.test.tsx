import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SECTION_IDS, SECTION_ORDER } from "@/shared/contracts/shell";

import { TitleBar } from "../TitleBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

describe("TitleBar section tabs", () => {
  // A nameless tablist is announced as just "tab list" — the user hears the
  // tabs but not what they switch between.
  it("names the tab list", () => {
    render(
      <TitleBar
        uiMode="full"
        onSwitchUIMode={() => {}}
        activeSection={SECTION_IDS.LIGHTS}
        onSectionChange={() => {}}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "shell:titleBar.sectionsAriaLabel" });
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(SECTION_ORDER.length);
  });

  // An arrow only moves focus: opening a page on the way past it would ask about the work it leaves.
  it("is one tab stop; the arrows move focus and Enter opens", () => {
    const onSectionChange = vi.fn<(id: string) => void>();
    render(
      <TitleBar uiMode="full" onSwitchUIMode={() => {}} activeSection={SECTION_IDS.LIGHTS} onSectionChange={onSectionChange} />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([screen.getByTestId(`section-tab-${SECTION_IDS.LIGHTS}`)]);

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    fireEvent.keyDown(tabs[tabs.length - 1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(onSectionChange).not.toHaveBeenCalled();

    fireEvent.click(tabs[1]!);
    expect(onSectionChange).toHaveBeenCalledWith(SECTION_ORDER[1]);
  });
});
