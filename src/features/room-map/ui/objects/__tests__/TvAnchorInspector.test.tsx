// Mount height is optional on purpose: absent ⇒ the worker resolves 40% of the
// room height at runtime, so a room-height edit moves it. The field must never
// write that default into storage, only an explicit value or `undefined`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TvAnchorInspector } from "../TvAnchorInspector";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${JSON.stringify(opts)}` : key,
  }),
}));

const baseTv: TvAnchorPlacement = { x: 1.5, y: 0, width: 1.2, height: 0.1 };

function renderInspector(tv: TvAnchorPlacement = baseTv, roomHeightMeters = 2.5) {
  const onUpdate = vi.fn();
  render(
    <TvAnchorInspector
      tv={tv}
      roomHeightMeters={roomHeightMeters}
      onUpdate={onUpdate}
      onToggleLock={vi.fn()}
    />,
  );
  const mount = screen.getByLabelText("roomMap:inspector.tvMountHeightLabel") as HTMLInputElement;
  return { onUpdate, mount };
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("TvAnchorInspector mount height", () => {
  beforeEach(cleanup);

  it("shows the computed default as a placeholder, not a value", () => {
    const { mount } = renderInspector(baseTv, 2.5);
    expect(mount.value).toBe("");
    expect(mount.placeholder).toBe("1.00");
  });

  it("recomputes the placeholder from the room height", () => {
    const { mount } = renderInspector(baseTv, 3);
    expect(mount.placeholder).toBe("1.20");
    expect(
      screen.getByText(/roomMap:inspector\.tvMountHeightHint/),
    ).toHaveTextContent('"metres":"1.20"');
  });

  it("writes an explicit mount height on commit", () => {
    const { onUpdate, mount } = renderInspector();
    commit(mount, "1.35");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ mountHeightMeters: 1.35 });
  });

  it("never writes the default when an empty field is focused and left", () => {
    const { onUpdate, mount } = renderInspector();
    fireEvent.focus(mount);
    fireEvent.blur(mount);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("clearing writes undefined so the default is resolved at runtime again", () => {
    const { onUpdate, mount } = renderInspector({ ...baseTv, mountHeightMeters: 1.1 });
    expect(mount.value).toBe("1.10");
    commit(mount, "");
    expect(onUpdate).toHaveBeenCalledWith({ mountHeightMeters: undefined });
  });

  it("clamps to the room height", () => {
    const { onUpdate, mount } = renderInspector(baseTv, 2.5);
    commit(mount, "4");
    expect(onUpdate).toHaveBeenCalledWith({ mountHeightMeters: 2.5 });
  });

  it("clamps above zero", () => {
    const { onUpdate, mount } = renderInspector(baseTv, 2.5);
    commit(mount, "-1");
    const written = onUpdate.mock.calls[0][0].mountHeightMeters as number;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(2.5);
  });

  it("does not rewrite an unchanged explicit value", () => {
    const { onUpdate, mount } = renderInspector({ ...baseTv, mountHeightMeters: 1.1 });
    fireEvent.focus(mount);
    fireEvent.blur(mount);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("warns when a room-height edit left the mount above the ceiling", () => {
    renderInspector({ ...baseTv, mountHeightMeters: 2.8 }, 2.5);
    expect(screen.getByText("roomMap:inspector.tvMountHeightAboveCeiling")).toBeInTheDocument();
  });

  it("labels the footprint field as depth, not height", () => {
    renderInspector();
    expect(screen.getByLabelText("roomMap:inspector.tvDepthLabel")).toBeInTheDocument();
    expect(screen.queryByLabelText("roomMap:inspector.heightLabel")).toBeNull();
  });
});
