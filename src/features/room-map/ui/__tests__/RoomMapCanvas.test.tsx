import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { RoomMapCanvas } from "../RoomMapCanvas";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
});
