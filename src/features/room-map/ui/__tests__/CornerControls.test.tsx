import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CornerControls, type CornerEditControls, EDIT_STAGES, type EditStage } from "../CornerControls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function edit(overrides: Partial<CornerEditControls> = {}): CornerEditControls {
  return {
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn<() => void>(),
    onRedo: vi.fn<() => void>(),
    zoom: 1,
    canvasSize: { w: 800, h: 600 },
    panOffset: { x: 0, y: 0 },
    anchor: { x: 400, y: 280 },
    onZoomChange: vi.fn<(zoom: number) => void>(),
    onPanChange: vi.fn<(pan: { x: number; y: number }) => void>(),
    onFitToView: vi.fn<() => void>(),
    ...overrides,
  };
}

describe("CornerControls", () => {
  it("keeps undo and redo reachable but inert while there is nothing to undo or redo", () => {
    const controls = edit();
    render(<CornerControls roomAware={null} edit={controls} />);
    const undo = screen.getByRole("button", { name: "roomMap:toolbar.undo" });
    const redo = screen.getByRole("button", { name: "roomMap:toolbar.redo" });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    expect(redo).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(undo);
    expect(controls.onUndo).not.toHaveBeenCalled();
  });

  it("undoes and redoes when there is history", () => {
    const controls = edit({ canUndo: true, canRedo: true });
    render(<CornerControls roomAware={null} edit={controls} />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:toolbar.undo" }));
    fireEvent.click(screen.getByRole("button", { name: "roomMap:toolbar.redo" }));
    expect(controls.onUndo).toHaveBeenCalledTimes(1);
    expect(controls.onRedo).toHaveBeenCalledTimes(1);
  });

  it("steps the zoom around the middle of the free region, not the canvas centre", () => {
    const controls = edit();
    render(<CornerControls roomAware={null} edit={controls} />);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:zoomControl.in" }));
    expect(controls.onPanChange).toHaveBeenCalledWith({ x: 400 - 400 * 1.1, y: 280 - 280 * 1.1 });
  });

  it("shows only the room-aware pill over the 3D room, and nothing when room-aware is off", () => {
    const { rerender, container } = render(<CornerControls roomAware={{ state: "active" }} />);
    expect(screen.getByRole("button", { name: "roomMap:roomAware.ariaLabel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "roomMap:toolbar.undo" })).not.toBeInTheDocument();

    rerender(<CornerControls roomAware={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reads paused, with the Hue reason, when Hue cannot stream", () => {
    render(<CornerControls roomAware={{ state: "paused", reason: "keyRejected" }} edit={edit()} />);
    expect(screen.queryByRole("button", { name: "roomMap:roomAware.ariaLabel" })).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "roomMap:roomAware.pausedAriaLabel" });
    expect(chip).toHaveTextContent("roomMap:roomAware.pausedLabel");
    fireEvent.click(chip);
    const panel = document.getElementById(chip.getAttribute("aria-controls") ?? "");
    expect(panel).toHaveTextContent("roomMap:roomAware.paused.keyRejected");
    expect(panel).toHaveTextContent("roomMap:roomAware.pausedWhy");
    expect(panel).not.toHaveTextContent("roomMap:roomAware.why");
  });

  // A disclosure rather than a hover tooltip, so the explanation is reachable
  // from the keyboard; Escape must close it without reaching the editor's own
  // Escape (deselect).
  it("discloses the room-aware explanation and closes it on Escape", () => {
    const onEditorKey = vi.fn();
    render(
      <div onKeyDown={onEditorKey}>
        <CornerControls roomAware={{ state: "active" }} edit={edit()} />
      </div>,
    );
    const chip = screen.getByRole("button", { name: "roomMap:roomAware.ariaLabel" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("roomMap:roomAware.body")).toBeNull();

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(chip.getAttribute("aria-controls") ?? "")).toBeVisible();

    fireEvent.keyDown(chip, { key: "Escape" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(onEditorKey).not.toHaveBeenCalled();
  });

  it("lists the editor's keys behind one button, without the retired panel toggle", () => {
    render(<CornerControls roomAware={null} edit={edit()} />);
    const help = screen.getByRole("button", { name: "roomMap:shortcuts.title" });
    fireEvent.click(help);
    const dialog = screen.getByRole("dialog", { name: "roomMap:shortcuts.title" });
    expect(dialog).toHaveTextContent("roomMap:shortcuts.undo");
    expect(Array.from(dialog.querySelectorAll("kbd"), (key) => key.textContent)).not.toContain("F");
  });

  it("names no carrying in View's camera hint, since View moves nothing", () => {
    render(<CornerControls roomAware={null} view={{ onZoomIn: vi.fn<() => void>(), onZoomOut: vi.fn<() => void>(), onReset: vi.fn<() => void>() }} />);
    expect(screen.getByRole("button", { name: "roomMap:view.resetCamera" })).toHaveAttribute("title", "roomMap:view.cameraHint");
  });

  // Editing in 3D: the plan's zoom means nothing to the room, but undo still does.
  it("offers the stage, the camera and the history alone while the room is edited in 3D", () => {
    const onChange = vi.fn<(stage: EditStage) => void>();
    const onUndo = vi.fn<() => void>();
    render(
      <CornerControls
        roomAware={null}
        stage={{ value: EDIT_STAGES.ROOM, onChange }}
        view={{ onZoomIn: vi.fn<() => void>(), onZoomOut: vi.fn<() => void>(), onReset: vi.fn<() => void>(), carries: true }}
        history={{ canUndo: true, canRedo: false, onUndo, onRedo: vi.fn<() => void>() }}
      />,
    );
    expect(screen.getByRole("radio", { name: "roomMap:stage.room" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:stage.plan" }));
    expect(onChange).toHaveBeenCalledWith(EDIT_STAGES.PLAN);
    fireEvent.click(screen.getByRole("button", { name: "roomMap:toolbar.undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "roomMap:zoomControl.fit" })).toBeNull();
    expect(screen.getByRole("button", { name: "roomMap:view.resetCamera" })).toHaveAttribute("title", "roomMap:view.cameraCarryHint");
    // One capsule, as on the plan, so undo stays put across a stage switch.
    expect(screen.getByRole("button", { name: "roomMap:toolbar.undo" }).parentElement).toContainElement(
      screen.getByRole("button", { name: "roomMap:view.resetCamera" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "roomMap:shortcuts.title" }));
    const keys = screen.getByRole("dialog", { name: "roomMap:shortcuts.title" });
    expect(keys).toHaveTextContent("roomMap:view.resetCamera");
    expect(keys).not.toHaveTextContent("roomMap:shortcuts.boxSelect");
    expect(keys).not.toHaveTextContent("roomMap:shortcuts.pan");
  });
});
