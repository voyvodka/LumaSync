import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomPicker, type RoomPickerProps } from "../RoomPicker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ROOMS = [
  { id: "a", name: "Salon", named: true },
  { id: "b", name: "Room 2", named: false },
];

function renderPicker(patch: Partial<RoomPickerProps> = {}) {
  const props: RoomPickerProps = {
    rooms: ROOMS,
    activeId: "a",
    busy: false,
    failed: false,
    announce: "",
    onSwitch: vi.fn<(id: string) => void>(),
    onRename: vi.fn<(id: string, name: string) => void>(),
    onDelete: vi.fn<(id: string) => void>(),
    onCopy: vi.fn<() => void>(),
    onFromTemplate: vi.fn<() => void>(),
    ...patch,
  };
  render(<RoomPicker {...props} />);
  const openList = () => act(() => fireEvent.click(screen.getByTestId("room-picker")));
  return { props, openList };
}

describe("RoomPicker", () => {
  it("names the room the lights follow at rest, and opens on it", () => {
    const { openList } = renderPicker();
    expect(screen.getByTestId("room-picker")).toHaveTextContent("Salon");
    expect(screen.queryByTestId("room-picker-list")).toBeNull();
    openList();
    expect(screen.getByTestId("room-switch-a")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("room-switch-a")).toHaveFocus();
  });

  it("switches on a press of another room, closes and goes back to the trigger", () => {
    const { props, openList } = renderPicker();
    openList();
    fireEvent.click(screen.getByTestId("room-switch-b"));
    expect(props.onSwitch).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("room-picker")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("room-picker")).toHaveFocus();
  });

  it("waits while a write is in flight", () => {
    const { props, openList } = renderPicker({ busy: true });
    openList();
    fireEvent.click(screen.getByTestId("room-switch-b"));
    expect(props.onSwitch).not.toHaveBeenCalled();
  });

  it("renames on Enter, puts the name back on Escape without closing the list", () => {
    const { props, openList } = renderPicker();
    openList();
    fireEvent.click(screen.getByTestId("room-rename-b"));
    const input = screen.getByTestId("room-name-input-b");
    // An unnamed room's field opens empty, its default as the hint.
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "Ofis" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("b", "Ofis");

    fireEvent.click(screen.getByTestId("room-rename-a"));
    const again = screen.getByTestId("room-name-input-a");
    expect(again).toHaveValue("Salon");
    fireEvent.change(again, { target: { value: "x" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("room-picker-list")).toBeInTheDocument();
  });

  it("deletes another room on a second press, and keeps the one the lights follow", () => {
    const { props, openList } = renderPicker();
    openList();
    fireEvent.click(screen.getByTestId("room-remove-a"));
    fireEvent.click(screen.getByTestId("room-remove-a"));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId("room-remove-a")).toHaveAttribute("aria-disabled", "true");

    const remove = screen.getByTestId("room-remove-b");
    fireEvent.click(remove);
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(props.onDelete).toHaveBeenCalledWith("b");
  });

  it("disarms a delete left alone", () => {
    vi.useFakeTimers();
    const { props, openList } = renderPicker();
    openList();
    fireEvent.click(screen.getByTestId("room-remove-b"));
    act(() => vi.advanceTimersByTime(3100));
    fireEvent.click(screen.getByTestId("room-remove-b"));
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("adds a copy or a room from a template, until the limit", () => {
    const { props, openList } = renderPicker();
    openList();
    fireEvent.click(screen.getByTestId("room-copy"));
    expect(props.onCopy).toHaveBeenCalledOnce();
    openList();
    fireEvent.click(screen.getByTestId("room-from-template"));
    expect(props.onFromTemplate).toHaveBeenCalledOnce();
    cleanup();

    const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, named: true }));
    const full = renderPicker({ rooms: many, activeId: "r0" });
    full.openList();
    expect(screen.getByTestId("room-copy")).toBeDisabled();
    expect(screen.getByTestId("room-picker-full")).toBeInTheDocument();
  });

  it("says when the room could not be saved", () => {
    const { openList } = renderPicker({ failed: true });
    openList();
    expect(screen.getByTestId("room-picker-failed")).toHaveTextContent("roomMap:rooms.saveFailed");
  });
});
