import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommitCapsule } from "../CommitCapsule";

const labels = { commit: "Save", committing: "Saving…", rest: "Saved", done: "Saved!", revert: "Revert", unsaved: "Unsaved" };

function renderCapsule(state: { dirty: boolean; ready: boolean; flash?: boolean }) {
  return render(
    <CommitCapsule
      dirty={state.dirty}
      ready={state.ready}
      committing={false}
      flash={state.flash ?? false}
      labels={labels}
      onCommit={vi.fn<() => void>()}
      onRevert={vi.fn<() => void>()}
    />,
  );
}

describe("CommitCapsule", () => {
  it("is a quiet status at rest, with nothing to press", () => {
    renderCapsule({ dirty: false, ready: false });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });

  it("offers Save and Revert for edits, and only Save for a layout never saved", () => {
    const { rerender } = renderCapsule({ dirty: true, ready: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("title", "Unsaved");
    expect(screen.getByRole("button", { name: "Revert" })).toBeInTheDocument();
    rerender(
      <CommitCapsule dirty={false} ready committing={false} flash={false} labels={labels} onCommit={() => {}} onRevert={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });
});
