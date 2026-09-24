import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";

import { ModeStrip } from "../ModeStrip";

describe("ModeStrip", () => {
  it.each(["full", "compact", "popup"] as const)("is a radio group in the %s look", (variant) => {
    render(<ModeStrip variant={variant} value={LIGHTING_MODE_KIND.AMBILIGHT} onSelect={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("walks the popup strip with the arrow keys — the popup had radios but no arrows", async () => {
    const onSelect = vi.fn();
    render(<ModeStrip variant="popup" value={LIGHTING_MODE_KIND.OFF} onSelect={onSelect} />);
    const [off, ambilight, solid] = screen.getAllByRole("radio");

    off?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(ambilight).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(solid).toHaveFocus();
    expect(onSelect.mock.calls).toEqual([[LIGHTING_MODE_KIND.AMBILIGHT], [LIGHTING_MODE_KIND.SOLID]]);
  });

  it("keeps a tab stop while a test pattern leaves no mode checked", () => {
    render(<ModeStrip variant="popup" value={null} onSelect={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(radios[0]).toHaveAttribute("tabindex", "0");
  });

  it("skips the modes that have no output to go to", async () => {
    const onSelect = vi.fn();
    render(
      <ModeStrip
        variant="compact"
        value={LIGHTING_MODE_KIND.OFF}
        isDisabled={(kind) => kind === LIGHTING_MODE_KIND.AMBILIGHT}
        onSelect={onSelect}
      />,
    );
    screen.getByTestId("mode-button-off").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("mode-button-solid")).toHaveFocus();
    expect(screen.getByTestId("mode-button-ambilight")).toBeDisabled();
    expect(onSelect).toHaveBeenCalledWith(LIGHTING_MODE_KIND.SOLID);
  });

  it("renders the registry keybind badge on the full strip only", () => {
    const { container, unmount } = render(
      <ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} onSelect={() => {}} />,
    );
    expect(container.querySelectorAll(".kb")).toHaveLength(3);
    unmount();
    const compact = render(<ModeStrip variant="compact" value={LIGHTING_MODE_KIND.OFF} onSelect={() => {}} />);
    expect(compact.container.querySelectorAll(".kb")).toHaveLength(0);
  });
});
