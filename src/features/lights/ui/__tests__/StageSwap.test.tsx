import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StageSwap } from "../StageSwap";

const reduced = vi.hoisted(() => ({ on: false }));
vi.mock("@/shared/lib/motion", () => ({ prefersReducedMotion: () => reduced.on }));

function stage(key: string, order: number) {
  return (
    <StageSwap stageKey={key} order={order}>
      <p data-testid={`stage-${key}`} id={`stage-${key}`}>
        {key}
      </p>
    </StageSwap>
  );
}

describe("StageSwap", () => {
  afterEach(() => {
    reduced.on = false;
    vi.useRealTimers();
  });

  // The old stage leaves as a still copy: out of the accessibility tree, no ids or test ids to
  // collide with the new one, gone once its exit has had time to play.
  it("passes the old stage out as an inert copy and the new one in", () => {
    vi.useFakeTimers();
    const view = render(stage("solid", 2));
    view.rerender(stage("effect", 3));

    expect(screen.getByTestId("stage-effect")).toBeInTheDocument();
    expect(screen.queryByTestId("stage-solid")).toBeNull();
    const ghost = view.container.querySelector("[inert]");
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost?.textContent).toBe("solid");
    expect(ghost?.querySelector("[id]")).toBeNull();

    act(() => vi.advanceTimersByTime(400));
    expect(view.container.querySelector("[inert]")).toBeNull();
  });

  it("just swaps under reduced motion", () => {
    reduced.on = true;
    const view = render(stage("solid", 2));
    view.rerender(stage("off", 0));
    expect(view.container.querySelector("[inert]")).toBeNull();
    expect(screen.getByTestId("stage-off")).toBeInTheDocument();
  });

  it("does nothing while the stage stays the same", () => {
    const view = render(stage("solid", 2));
    view.rerender(stage("solid", 2));
    expect(view.container.querySelector("[inert]")).toBeNull();
  });
});
