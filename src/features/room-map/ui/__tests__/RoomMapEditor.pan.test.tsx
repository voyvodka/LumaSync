/**
 * A pan moves the canvas's object layer with a CSS transform and commits the
 * offset once, on release. The canvas and the editor are real; the object
 * components are counters wrapped in `memo`, as the real ones are (asserted in
 * `RoomMapEditor.gestures.test.tsx`), so a count that moves means the editor
 * handed an object a prop that changed.
 */
import type React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { RoomMapEditor } from "../RoomMapEditor";

const renders = vi.hoisted(() => ({ furniture: 0, tv: 0, usb: 0, hue: 0, toolbar: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/features/device/useUsbConnectionStatus", () => ({
  useUsbConnectionStatus: () => ({ ready: false, connectedPort: null }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () =>
      Promise.resolve({
        lastHueAreaId: "area-1",
        roomMap: {
          ...DEFAULT_ROOM_MAP,
          tvAnchor: { x: 2, y: 0.3, width: 1, height: 0.1 },
          furniture: [
            { id: "a", type: "sofa", x: 1, y: 2, width: 1, height: 1 },
            { id: "b", type: "table", x: 3, y: 2, width: 1, height: 1 },
          ],
          usbStrips: [{ stripId: "s", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 60 }],
          hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, entertainmentAreaId: "area-1" }],
        },
      }),
    save: () => Promise.resolve(),
  },
}));

vi.mock("../objects/FurnitureObject", async () => {
  const { memo } = await import("react");
  return { FurnitureObject: memo(() => { renders.furniture += 1; return null; }) };
});
vi.mock("../objects/TvAnchorObject", async () => {
  const { memo } = await import("react");
  return { TvAnchorObject: memo(() => { renders.tv += 1; return null; }) };
});
vi.mock("../objects/UsbStripObject", async () => {
  const { memo } = await import("react");
  return { UsbStripObject: memo(() => { renders.usb += 1; return null; }) };
});
vi.mock("../HueChannelOverlay", async () => {
  const { memo } = await import("react");
  return { HueChannelOverlay: memo(() => { renders.hue += 1; return null; }) };
});
// Not memoised: it re-renders with the editor, so it counts editor renders.
vi.mock("../RoomMapToolbar", () => ({
  RoomMapToolbar: (_props: Record<string, unknown>): React.ReactElement | null => {
    renders.toolbar += 1;
    return null;
  },
}));

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let realResizeObserver: typeof globalThis.ResizeObserver;

beforeEach(() => {
  for (const key of Object.keys(renders) as (keyof typeof renders)[]) renders[key] = 0;
  realResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

describe("RoomMapEditor — panning", () => {
  it("moves the layer without rendering, commits once, and re-renders no object", async () => {
    const { getByTestId } = render(<RoomMapEditor />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const layer = getByTestId("room-map-object-layer");
    const canvas = layer.parentElement as HTMLElement;
    expect(renders.furniture).toBe(2);
    expect(renders.tv).toBe(1);
    expect(renders.usb).toBe(1);
    expect(renders.hue).toBe(1);

    const before = { ...renders };
    const startTransform = layer.style.transform;

    // Middle button pans whatever is under the pointer.
    fireEvent.pointerDown(canvas, { button: 1, clientX: 200, clientY: 200, pointerId: 1 });
    for (let i = 1; i <= 30; i++) {
      fireEvent.pointerMove(canvas, { clientX: 200 + i * 5, clientY: 200 + i * 2, pointerId: 1 });
    }

    // Mid-pan: the layer has moved and nothing rendered to move it.
    expect(layer.style.transform).toBe("translate(150px, 60px) scale(1)");
    expect(layer.style.transform).not.toBe(startTransform);
    expect(renders).toEqual(before);

    fireEvent.pointerUp(canvas, { clientX: 350, clientY: 260, pointerId: 1 });

    // The commit renders the editor once and keeps the layer where it was left.
    expect(renders.toolbar).toBe(before.toolbar + 1);
    expect(layer.style.transform).toBe("translate(150px, 60px) scale(1)");
    expect(renders.furniture).toBe(before.furniture);
    expect(renders.tv).toBe(before.tv);
    expect(renders.usb).toBe(before.usb);
    expect(renders.hue).toBe(before.hue);
  });
});
