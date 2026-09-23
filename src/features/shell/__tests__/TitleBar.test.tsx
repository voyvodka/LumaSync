import { render, screen } from "@testing-library/react";
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
});
