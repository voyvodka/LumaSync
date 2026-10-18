import { act, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StageChoice } from "../Stage";

// The test DOM has no layout: each option is 80 px wide, side by side, inside its group.
const originals = ["offsetParent", "offsetLeft", "offsetWidth", "clientWidth"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "radio" ? this.parentElement : null;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "radio" ? [...this.parentElement!.children].indexOf(this) * 80 : 2;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 80 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 164 });
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
});

const OPTIONS = [
  { value: "colour", label: "Colour" },
  { value: "white", label: "White" },
] as const;

describe("StageChoice", () => {
  it("puts one fill under the chosen value, which travels only after it has landed", async () => {
    const { container, rerender } = render(
      <StageChoice ariaLabel="Tone" options={OPTIONS} value="colour" onChange={() => {}} />,
    );
    const thumb = () => container.querySelector<HTMLElement>("[aria-hidden='true']")!;
    expect(thumb().style.left).toBe("2px");
    expect(thumb().className).not.toMatch(/choiceMoving/);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(thumb().className).toMatch(/choiceMoving/);

    rerender(<StageChoice ariaLabel="Tone" options={OPTIONS} value="white" onChange={() => {}} />);
    expect(thumb().style.left).toBe("82px");
    expect(thumb().style.right).toBe("2px");
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "true");
  });
});
