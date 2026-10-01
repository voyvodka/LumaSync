import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";

import { ModeStrip } from "../ModeStrip";

describe("ModeStrip", () => {
  it.each(["full", "compact"] as const)("is a power switch and a radio group of the lit modes in the %s look", (variant) => {
    render(<ModeStrip variant={variant} value={LIGHTING_MODE_KIND.AMBILIGHT} onSelect={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("keeps Off among the popup's radios", () => {
    render(<ModeStrip variant="popup" value={LIGHTING_MODE_KIND.AMBILIGHT} onSelect={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
  });

  it("turns the lights off from a lit mode, and back on in the last lit one", async () => {
    const onSelect = vi.fn<(kind: string) => void>();
    const view = render(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.SOLID} lastLit="solid" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onSelect).toHaveBeenLastCalledWith(LIGHTING_MODE_KIND.OFF);

    view.rerender(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} lastLit="effect" onSelect={onSelect} />);
    const power = screen.getByRole("switch");
    expect(power).toHaveAttribute("aria-checked", "false");
    // Off checks no mode; the grey mark rests on the one the button brings back.
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(view.container.querySelector("[data-off]")).not.toBeNull();
    await userEvent.click(power);
    expect(onSelect).toHaveBeenLastCalledWith(LIGHTING_MODE_KIND.EFFECT);
  });

  it("locks the power button only when what it would do is locked", () => {
    const isDisabled = (kind: string) => kind !== LIGHTING_MODE_KIND.OFF;
    const view = render(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.AMBILIGHT} isDisabled={isDisabled} onSelect={() => {}} />);
    expect(screen.getByRole("switch")).toBeEnabled();
    view.rerender(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} isDisabled={isDisabled} onSelect={() => {}} />);
    expect(screen.getByRole("switch")).toBeDisabled();
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
        value={LIGHTING_MODE_KIND.AMBILIGHT}
        isDisabled={(kind) => kind === LIGHTING_MODE_KIND.SOLID}
        onSelect={onSelect}
      />,
    );
    screen.getByTestId("mode-button-ambilight").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("mode-button-effect")).toHaveFocus();
    expect(screen.getByTestId("mode-button-solid")).toBeDisabled();
    expect(onSelect).toHaveBeenCalledWith(LIGHTING_MODE_KIND.EFFECT);
  });

  it("renders the registry keybind badge on the full strip only", () => {
    const { container, unmount } = render(
      <ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} onSelect={() => {}} />,
    );
    // The lit modes' ⌥2–⌥4; Off's ⌥1 is the power button's.
    expect(container.querySelectorAll('[data-part="keybind"]')).toHaveLength(3);
    unmount();
    const compact = render(<ModeStrip variant="compact" value={LIGHTING_MODE_KIND.OFF} onSelect={() => {}} />);
    expect(compact.container.querySelectorAll('[data-part="keybind"]')).toHaveLength(0);
  });

  it("holds a press while a choice is in flight, without dimming a tile", async () => {
    const onSelect = vi.fn<(kind: string) => void>();
    const view = render(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} busy onSelect={onSelect} />);
    const ambilight = screen.getByTestId("mode-button-ambilight");
    expect(ambilight).toBeEnabled();
    await userEvent.click(ambilight);
    expect(onSelect).not.toHaveBeenCalled();
    view.rerender(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId("mode-button-ambilight"));
    expect(onSelect).toHaveBeenCalledWith(LIGHTING_MODE_KIND.AMBILIGHT);
  });

  it("says ⌥1 only where the power button turns the lights off", () => {
    const view = render(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.SOLID} onSelect={() => {}} />);
    expect(screen.getByRole("switch").title).toMatch(/\(.+\)$/);
    view.rerender(<ModeStrip variant="full" value={LIGHTING_MODE_KIND.OFF} onSelect={() => {}} />);
    expect(screen.getByRole("switch").title).not.toMatch(/\(.+\)$/);
  });
});

describe("ModeStrip — a subtitle", () => {
  const strip = (solid: { text: string; key: string }) => (
    <ModeStrip
      variant="full"
      value={LIGHTING_MODE_KIND.SOLID}
      onSelect={() => {}}
      subtitles={{ [LIGHTING_MODE_KIND.SOLID]: solid }}
    />
  );

  it("fades in when its form changes, and not when the page opens or a number moves within it", () => {
    const view = render(strip({ key: "colour", text: "#FFFFFF · 100%" }));
    expect(screen.getByText("#FFFFFF · 100%")).not.toHaveAttribute("data-swapped");
    view.rerender(strip({ key: "colour", text: "#FFFFFF · 60%" }));
    expect(screen.getByText("#FFFFFF · 60%")).not.toHaveAttribute("data-swapped");
    view.rerender(strip({ key: "white", text: "4000 K · 60%" }));
    expect(screen.getByText("4000 K · 60%")).toHaveAttribute("data-swapped");
  });
});
