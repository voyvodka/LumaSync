import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ShortcutsRow } from "../HelpRows";

function stubPlatform(userAgent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("");
}

function keysFor(label: string): string[] {
  const term = screen.getByText(label);
  const item = term.parentElement;
  if (!item) throw new Error(`no item for ${label}`);
  return within(item)
    .getAllByText((_, el) => el?.tagName === "KBD")
    .map((kbd) => kbd.textContent ?? "");
}

describe("ShortcutsRow", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists every shortcut with the keys the handlers match on macOS", () => {
    stubPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    render(<ShortcutsRow />);

    expect(keysFor("shell:keybind.modeOff")).toEqual(["⌥", "1"]);
    expect(keysFor("shell:keybind.openSettings")).toEqual(["⌘", ","]);
    expect(keysFor("settings:help.shortcuts.zoomIn")).toEqual(["⌘", "+"]);
    expect(keysFor("settings:help.shortcuts.zoomReset")).toEqual(["⌘", "0"]);
  });

  it("uses Ctrl and Alt elsewhere", () => {
    stubPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    render(<ShortcutsRow />);

    expect(keysFor("shell:keybind.modeSolid")).toEqual(["Alt", "3"]);
    expect(keysFor("settings:help.shortcuts.zoomOut")).toEqual(["Ctrl", "−"]);
  });
});
