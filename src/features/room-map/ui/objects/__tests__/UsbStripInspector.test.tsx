import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

import { type UsbStripConnectionStatus, UsbStripInspector } from "../UsbStripInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const strip: UsbStripPlacement = { stripId: "s", startX: 1, startY: 0.2, endX: 3, endY: 0.2, ledCount: 60 };

function renderInspector(
  overrides: Partial<UsbStripPlacement> = {},
  connectionStatus: UsbStripConnectionStatus = "unknown",
  port: string | null = null,
) {
  const handlers = {
    onUpdate: vi.fn<(patch: Partial<UsbStripPlacement>) => void>(),
    onMove: vi.fn<(x: number, y: number) => void>(),
    onToggleLock: vi.fn<() => void>(),
    onDuplicate: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    onManage: vi.fn<() => void>(),
  };
  render(<UsbStripInspector strip={{ ...strip, ...overrides }} connectionStatus={connectionStatus} port={port} {...handlers} />);
  return handlers;
}

const enter = (name: string, value: string) => {
  const input = screen.getByRole("spinbutton", { name }) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("UsbStripInspector", () => {
  beforeEach(() => cleanup());

  it("moves the strip by its start point, keeping the other axis", () => {
    const { onMove } = renderInspector();
    enter("roomMap:inspector.xLabel", "1.5");
    expect(onMove).toHaveBeenLastCalledWith(1.5, 0.2);
    enter("roomMap:inspector.yLabel", "0.4");
    expect(onMove).toHaveBeenLastCalledWith(1, 0.4);
  });

  it("takes a whole LED count and puts back one out of range", () => {
    const { onUpdate } = renderInspector();
    enter("roomMap:inspector.usbLedCountLabel", "72.4");
    expect(onUpdate).toHaveBeenLastCalledWith({ ledCount: 72 });
    enter("roomMap:inspector.usbLedCountLabel", "5000");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("holds the numbers and the delete while the strip is locked", () => {
    renderInspector({ locked: true });
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "roomMap:objectPanel.delete" })).toBeDisabled();
  });

  it("says nothing about the port before the first snapshot, then the state and the port", () => {
    renderInspector();
    expect(screen.queryByText("roomMap:inspector.usbConnectedFallback")).toBeNull();
    expect(screen.queryByText("roomMap:inspector.usbConnectionDisconnected")).toBeNull();
    cleanup();
    renderInspector({ portName: "COM3" }, "connected", "COM3");
    expect(screen.getByText("roomMap:inspector.usbConnectedFallback")).toBeInTheDocument();
    expect(screen.getByText("COM3")).toBeInTheDocument();
  });

  it("duplicates, manages in Devices and closes from its row", () => {
    const handlers = renderInspector();
    fireEvent.click(screen.getByRole("button", { name: "roomMap:contextMenu.duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:inspector.usbManage" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.close" }));
    expect(handlers.onDuplicate).toHaveBeenCalledTimes(1);
    expect(handlers.onManage).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
