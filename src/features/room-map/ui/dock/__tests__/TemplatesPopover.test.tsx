import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { PREVIEW_INTENT_MS, TemplatesPopover } from "../TemplatesPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function Harness(props: { onPreview: (template: RoomMapConfig | null) => void; onApply: (template: RoomMapConfig) => void; onClose?: () => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchor} type="button">
        anchor
      </button>
      <TemplatesPopover open onClose={props.onClose ?? (() => {})} anchorRef={anchor} id="t" onPreview={props.onPreview} onApply={props.onApply} />
    </>
  );
}

const card = (id: string) => screen.getByTestId(`template-${id}`);
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TemplatesPopover", () => {
  it("shows the template the pointer rests on, not every one it crosses, and the room again once it leaves", () => {
    const onPreview = vi.fn<(template: RoomMapConfig | null) => void>();
    render(<Harness onPreview={onPreview} onApply={vi.fn<(template: RoomMapConfig) => void>()} />);
    onPreview.mockClear();
    fireEvent.pointerEnter(card("tv55"));
    wait(PREVIEW_INTENT_MS / 2);
    fireEvent.pointerEnter(card("showroom"));
    wait(PREVIEW_INTENT_MS);
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview.mock.calls[0]![0]!.dimensions.widthMeters).toBe(12.5);
    fireEvent.pointerLeave(screen.getByTestId("templates-cards"));
    wait(PREVIEW_INTENT_MS);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("previews from the keys too, and applies the pressed template without a late preview after it", () => {
    const onPreview = vi.fn<(template: RoomMapConfig | null) => void>();
    const onApply = vi.fn<(template: RoomMapConfig) => void>();
    render(<Harness onPreview={onPreview} onApply={onApply} />);
    // Opening lands on the first card, which is a rest of its own.
    expect(card("tv55")).toHaveFocus();
    wait(PREVIEW_INTENT_MS);
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ tvAnchor: expect.objectContaining({ width: 1.2 }) }));
    fireEvent.keyDown(card("tv55"), { key: "ArrowRight" });
    expect(card("ldesk")).toHaveFocus();
    onPreview.mockClear();
    fireEvent.click(card("ldesk"));
    wait(PREVIEW_INTENT_MS * 2);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ dimensions: expect.objectContaining({ widthMeters: 3 }) }));
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("closes when Tab leaves it, handing focus back to its anchor", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onPreview={vi.fn<(template: RoomMapConfig | null) => void>()} onApply={vi.fn<(template: RoomMapConfig) => void>()} onClose={onClose} />);
    fireEvent.blur(card("tv55"), { relatedTarget: null });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "anchor" })).toHaveFocus();
  });
});
