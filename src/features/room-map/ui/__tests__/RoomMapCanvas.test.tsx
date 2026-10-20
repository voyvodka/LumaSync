import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { imageLayerObjectId } from "../../model/objectId";
import { RoomMapCanvas } from "../RoomMapCanvas";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../roomMapFilesApi", () => ({
  readRoomMapImage: () => Promise.resolve(new Uint8Array([1, 2, 3])),
}));

describe("RoomMapCanvas — the toolbar fade", () => {
  it("covers the viewport's top band in object-layer pixels at any pan and zoom", () => {
    const view = render(
      <RoomMapCanvas
        config={DEFAULT_ROOM_MAP}
        pxPerMeter={100}
        canvasSize={{ w: 800, h: 500 }}
        showGrid
        gridStrokeWidth={1}
        selectedId={null}
        onCanvasClick={() => {}}
        zoom={2}
        panOffset={{ x: 120, y: -60 }}
      />,
    );
    const fade = view.getByTestId("room-map-toolbar-fade");
    // The viewport's top-left is (-120, 60) on screen ÷ 2 → (-60, 30) in the layer.
    expect(fade.style.left).toBe("-60px");
    expect(fade.style.top).toBe("30px");
    expect(fade.style.width).toBe("400px");
    expect(fade.style.height).toBe("36px");
    expect(Number(fade.style.zIndex)).toBeLessThan(10);
  });

  it("stays on the viewport's top through a two-finger slide, before the pan is committed", () => {
    const onPanChange = vi.fn<(pan: { x: number; y: number }) => void>();
    const view = render(
      <RoomMapCanvas
        config={DEFAULT_ROOM_MAP}
        pxPerMeter={100}
        canvasSize={{ w: 800, h: 500 }}
        showGrid
        gridStrokeWidth={1}
        selectedId={null}
        onCanvasClick={() => {}}
        zoom={2}
        panOffset={{ x: 120, y: -60 }}
        onZoomChange={vi.fn<(zoom: number) => void>()}
        onPanChange={onPanChange}
      />,
    );
    fireEvent.wheel(view.getByTestId("room-map-object-layer"), { deltaX: 20, deltaY: 40 });
    expect(onPanChange).not.toHaveBeenCalled();
    const fade = view.getByTestId("room-map-toolbar-fade");
    // The layer now sits at (100, -100): the viewport's top-left is (-50, 50) in it.
    expect(fade.style.left).toBe("-50px");
    expect(fade.style.top).toBe("50px");
  });
});

describe("RoomMapCanvas — an image layer", () => {
  const LAYER = { id: "img-1", path: "/x/plan.png", label: "Plan", offsetX: 10, offsetY: 20, scale: 1 };

  async function renderImage() {
    URL.createObjectURL = () => "blob:plan";
    URL.revokeObjectURL = () => {};
    const onTransform = vi.fn<(id: string, ox: number, oy: number, scale: number, sx?: number, sy?: number, continuous?: boolean) => void>();
    const view = render(
      <RoomMapCanvas
        config={{ ...DEFAULT_ROOM_MAP, imageLayers: [LAYER] }}
        pxPerMeter={100}
        canvasSize={{ w: 800, h: 500 }}
        showGrid={false}
        gridStrokeWidth={1}
        selectedId={imageLayerObjectId("img-1")}
        onCanvasClick={() => {}}
        onImageLayerTransformChange={onTransform}
      />,
    );
    await act(async () => {});
    const img = view.getByAltText("Plan") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 200 });
    Object.defineProperty(img, "naturalHeight", { value: 100 });
    fireEvent.load(img);
    img.setPointerCapture = () => {};
    return { img, frame: img.parentElement!, onTransform };
  }

  it("leaves a trackpad's two-finger slide to the canvas, and scales on a pinch", async () => {
    const { img, onTransform } = await renderImage();
    fireEvent.wheel(img, { deltaX: 3, deltaY: 7.5 });
    expect(onTransform).not.toHaveBeenCalled();
    // jsdom's WheelEvent drops the modifier keys of its init.
    const pinch = createEvent.wheel(img, { deltaY: -4 });
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    fireEvent(img, pinch);
    expect(onTransform).toHaveBeenCalledTimes(1);
  });

  it("puts a dragged image back on Escape and writes nothing", async () => {
    const { img, frame, onTransform } = await renderImage();
    const before = frame.style.transform;
    fireEvent.pointerDown(img, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 60, clientY: 0, pointerId: 1 });
    expect(frame.style.transform).not.toBe(before);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(img, { pointerId: 1 });
    expect(frame.style.transform).toBe(before);
    expect(onTransform).not.toHaveBeenCalled();
  });
});

describe("RoomMapCanvas — a marquee the system takes", () => {
  it("selects nothing, and the next click on the floor still lands", () => {
    const onMarquee = vi.fn<(box: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => void>();
    const onCanvasClick = vi.fn<() => void>();
    const view = render(
      <RoomMapCanvas
        config={DEFAULT_ROOM_MAP}
        pxPerMeter={100}
        canvasSize={{ w: 800, h: 500 }}
        showGrid={false}
        gridStrokeWidth={1}
        selectedId={null}
        onCanvasClick={onCanvasClick}
        onMarquee={onMarquee}
      />,
    );
    const floor = view.getByTestId("room-map-object-layer");
    floor.setPointerCapture = () => {};
    floor.parentElement!.setPointerCapture = () => {};
    fireEvent.pointerDown(floor, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(floor, { clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerCancel(floor, { pointerId: 1 });
    expect(onMarquee).not.toHaveBeenCalled();

    fireEvent.pointerDown(floor, { button: 0, clientX: 50, clientY: 50, pointerId: 2 });
    fireEvent.pointerUp(floor, { clientX: 50, clientY: 50, pointerId: 2 });
    fireEvent.click(floor);
    expect(onCanvasClick).toHaveBeenCalledOnce();
  });
});
