// Mount height is optional on purpose: absent ⇒ the worker resolves 40% of the
// room height at runtime, so a room-height edit moves it. The field must never
// write that default into storage, only an explicit value or `undefined`.
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TvAnchorInspector } from "../TvAnchorInspector";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${JSON.stringify(opts)}` : key,
  }),
}));

const baseTv: TvAnchorPlacement = { x: 1.5, y: 0, width: 1.2, height: 0.1 };

function renderInspector(tv: TvAnchorPlacement = baseTv, roomHeightMeters = 2.5, sizeUnit: "inch" | "cm" = "inch", modelChoices = true) {
  const onUpdate = vi.fn<(patch: Partial<TvAnchorPlacement>) => void>();
  const onDelete = vi.fn<() => void>();
  const onSizeUnitChange = vi.fn<(unit: "inch" | "cm") => void>();
  render(
    <TvAnchorInspector
      tv={tv}
      roomHeightMeters={roomHeightMeters}
      autoKind="tv"
      modelChoices={modelChoices}
      sizeUnit={sizeUnit}
      onSizeUnitChange={onSizeUnitChange}
      onUpdate={onUpdate}
      onToggleLock={vi.fn<() => void>()}
      onDelete={onDelete}
      onClose={vi.fn<() => void>()}
    />,
  );
  const mount = screen.getByLabelText("roomMap:inspector.tvMountHeightLabel") as HTMLInputElement;
  return { onUpdate, onDelete, onSizeUnitChange, mount };
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

  it("recomputes the placeholder from the room height, and says so behind its ⓘ", () => {
    const { mount } = renderInspector(baseTv, 3);
    expect(mount.placeholder).toBe("1.20");
    fireEvent.click(screen.getByRole("button", { name: /^common:hintFor .*tvMountHeightLabel/ }));
    expect(screen.getByText(/roomMap:inspector\.tvMountHeightHint/)).toHaveTextContent('"metres":"1.20"');
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

  // Out of range puts the old value back rather than writing the nearest bound (design-language.md).
  it("puts the old value back for a height above the room", () => {
    const { onUpdate, mount } = renderInspector(baseTv, 2.5);
    commit(mount, "4");
    expect(onUpdate).not.toHaveBeenCalled();
    expect((mount as HTMLInputElement).value).toBe("");
  });

  it("puts the old value back for a height at or below the floor", () => {
    const { onUpdate, mount } = renderInspector({ ...baseTv, mountHeightMeters: 1.1 }, 2.5);
    commit(mount, "-1");
    expect(onUpdate).not.toHaveBeenCalled();
    expect((mount as HTMLInputElement).value).toBe("1.10");
  });

  it("takes the top of the range as typed", () => {
    const { onUpdate, mount } = renderInspector(baseTv, 2.5);
    commit(mount, "2,5");
    expect(onUpdate).toHaveBeenCalledWith({ mountHeightMeters: 2.5 });
  });

  it("does not rewrite an unchanged explicit value", () => {
    const { onUpdate, mount } = renderInspector({ ...baseTv, mountHeightMeters: 1.1 });
    fireEvent.focus(mount);
    fireEvent.blur(mount);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("warns in a word when a room-height edit left the mount above the ceiling, the reason as its tooltip", () => {
    renderInspector({ ...baseTv, mountHeightMeters: 2.8 }, 2.5);
    const note = screen.getByText("roomMap:inspector.tvAboveCeilingShort");
    expect(note.closest("[title]")).toHaveAttribute("title", "roomMap:inspector.tvMountHeightAboveCeiling");
  });

  it("deletes from the row's end, but not while the TV is locked", () => {
    const { onDelete } = renderInspector();
    fireEvent.click(screen.getByRole("button", { name: "roomMap:objectPanel.delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    cleanup();
    renderInspector({ ...baseTv, locked: true });
    expect(screen.getByRole("button", { name: "roomMap:objectPanel.delete" })).toBeDisabled();
  });

});

describe("TvAnchorInspector — screen size", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const size = () => screen.getByTestId("tv-size") as HTMLInputElement;

  // The footprint's depth moved the screen off its wall and read as the screen's size.
  it("asks for the diagonal, not the footprint", () => {
    renderInspector();
    expect(size().value).toBe("54");
    expect(size()).toHaveAccessibleName('roomMap:inspector.screenSizeLabel {"width":"1.20","height":"0.68"}');
    expect(screen.getAllByRole("spinbutton")).toHaveLength(4);
  });

  it("writes the width a typed diagonal makes, keeping the screen's centre", () => {
    const { onUpdate } = renderInspector();
    commit(size(), "65");
    const patch = onUpdate.mock.lastCall![0];
    expect(patch.width).toBeCloseTo(1.439, 3);
    expect(patch.x! + patch.width! / 2).toBeCloseTo(baseTv.x + baseTv.width / 2, 6);
  });

  it("shows centimetres where they were chosen, and its unit switches between the two", () => {
    const { onSizeUnitChange } = renderInspector(baseTv, 2.5, "cm");
    expect(size().value).toBe("138");
    const unit = screen.getByRole("button", { name: "roomMap:inspector.screenSizeToInch" });
    fireEvent.pointerDown(unit, { button: 0 });
    fireEvent.pointerUp(unit, { button: 0 });
    fireEvent.click(unit);
    expect(onSizeUnitChange).toHaveBeenCalledWith("inch");
    expect(size()).not.toHaveFocus();
  });

  it("switches the unit of a locked screen too, a view choice that writes nothing", () => {
    const { onUpdate, onSizeUnitChange } = renderInspector({ ...baseTv, locked: true });
    fireEvent.click(screen.getByRole("button", { name: "roomMap:inspector.screenSizeToCm" }));
    expect(onSizeUnitChange).toHaveBeenCalledWith("cm");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers a shape only where the 3D room draws it", () => {
    renderInspector(baseTv, 2.5, "inch", false);
    expect(screen.queryByRole("button", { name: /^roomMap:inspector\.screenAspectLabel: / })).toBeNull();
  });

  it("keeps the diagonal across a new shape, and stores 16:9 as nothing", () => {
    const { onUpdate } = renderInspector();
    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector\.screenAspectLabel: / }));
    fireEvent.click(screen.getByRole("option", { name: "21:9" }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const patch = onUpdate.mock.lastCall![0];
    expect(patch.screenAspect).toBe("21:9");
    expect(patch.width! * Math.hypot(1, 9 / 21)).toBeCloseTo(baseTv.width * Math.hypot(1, 9 / 16), 3);
    expect(patch.x! + patch.width! / 2).toBeCloseTo(baseTv.x + baseTv.width / 2, 6);
    cleanup();
    const again = renderInspector({ ...baseTv, screenAspect: "21:9" });
    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector\.screenAspectLabel: / }));
    fireEvent.click(screen.getByRole("option", { name: "16:9" }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(again.onUpdate.mock.lastCall![0]).toHaveProperty("screenAspect", undefined);
  });
});

describe("TvAnchorInspector — screen kind", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const picker = () => screen.getByRole("button", { name: /^roomMap:inspector\.screenKindLabel: / });
  /** A pick lands after the list's short exit. */
  const choose = (name: string | RegExp) => {
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole("option", { name }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
  };

  it("names what Auto reads as and stores a pick", () => {
    const { onUpdate } = renderInspector();
    expect(picker().textContent).toContain("roomMap:inspector.screenKind.tv");
    choose("roomMap:inspector.screenKind.monitor");
    expect(onUpdate).toHaveBeenLastCalledWith({ screenKind: "monitor" });
  });

  it("clears the pick back to Auto", () => {
    const { onUpdate } = renderInspector({ ...baseTv, screenKind: "monitor" });
    choose(/roomMap:inspector\.screenKindAuto/);
    expect(onUpdate).toHaveBeenLastCalledWith({ screenKind: undefined });
  });
});
