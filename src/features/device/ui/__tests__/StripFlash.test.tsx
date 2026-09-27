import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { FlashDeps } from "../../state/stripFlash";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/preview/previewApi", () => ({ startLedTestPattern: async () => ({}), stopLedTestPattern: async () => ({}) }));

import { StripFlash } from "../StripFlash";

function deps() {
  return {
    start: vi.fn<FlashDeps["start"]>(async () => ({ active: true, previewOnly: false }) as never),
    stop: vi.fn<FlashDeps["stop"]>(async () => ({}) as never),
    wait: async () => {},
  } satisfies FlashDeps;
}

describe("StripFlash — the flash after adding", () => {
  // StrictMode runs an effect twice; two flashes would light the strip twice on hardware.
  it("flashes once, even under StrictMode, and asks", async () => {
    const d = deps();
    const onAutoDone = vi.fn<() => void>();
    render(
      <StrictMode>
        <StripFlash stripId="s" label="flash" onProblem={() => {}} auto onAutoDone={onAutoDone} deps={d} />
      </StrictMode>,
    );
    expect(await screen.findByTestId("strip-flash-question")).toBeInTheDocument();
    expect(d.start).toHaveBeenCalledTimes(1);
  });

  it("waits while the button cannot be pressed", () => {
    const d = deps();
    render(<StripFlash stripId="s" label="flash" onProblem={() => {}} auto disabled deps={d} />);
    expect(d.start).not.toHaveBeenCalled();
  });
});
