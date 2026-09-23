/**
 * The editor on its real state path — reducer, object components, dock — with
 * only the Tauri boundary and the store file mocked. What these pin is what a
 * gesture costs: undo entries and `shellStore.save` calls.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { GESTURE_COALESCE_MS } from "../../state/roomMapReducer";
import { HueChannelOverlay } from "../HueChannelOverlay";
import { FurnitureObject } from "../objects/FurnitureObject";
import { TvAnchorObject } from "../objects/TvAnchorObject";
import { UsbStripObject } from "../objects/UsbStripObject";
import { RoomMapEditor } from "../RoomMapEditor";

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

const store = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  save: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(store.state),
    save: (partial: Record<string, unknown>) => store.save(partial),
  },
}));

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SOFA = { id: "sofa", type: "sofa" as const, x: 1, y: 2, width: 1, height: 1, label: "Sofa" };

function stored(roomMap: Partial<RoomMapConfig>, extra: Record<string, unknown> = {}) {
  store.state = {
    roomMap: { ...DEFAULT_ROOM_MAP, ...roomMap },
    roomMapShowGrid: true,
    ...extra,
  };
}

function roomMapSaves(): RoomMapConfig[] {
  return store.save.mock.calls
    .map(([partial]) => (partial as { roomMap?: RoomMapConfig }).roomMap)
    .filter((m): m is RoomMapConfig => m !== undefined);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The sofa on the canvas, not its row in the dock's object list. */
function canvasSofa(): HTMLElement {
  const label = screen
    .getAllByText("Sofa")
    .find((el) => el.parentElement?.classList.contains("cursor-grab"));
  if (!label?.parentElement) throw new Error("sofa is not on the canvas");
  return label.parentElement;
}

async function renderEditor() {
  const view = render(<RoomMapEditor />);
  await flush();
  const root = view.container.querySelector(".lm-room-editor") as HTMLElement;
  expect(root).not.toBeNull();
  return { ...view, root };
}

let realResizeObserver: typeof globalThis.ResizeObserver;

beforeEach(() => {
  store.save.mockReset();
  store.save.mockResolvedValue(undefined);
  realResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  vi.useRealTimers();
});

describe("RoomMapEditor — a drag is one undo step and one save", () => {
  it("commits a twenty-move drag once, and one undo puts it back", async () => {
    stored({ furniture: [SOFA] });
    const { root } = await renderEditor();
    const sofa = canvasSofa();

    fireEvent.pointerDown(sofa, { clientX: 100, clientY: 100, pointerId: 1 });
    for (let i = 1; i <= 20; i++) {
      fireEvent.pointerMove(sofa, { clientX: 100 + i * 8, clientY: 100, pointerId: 1 });
    }
    expect(roomMapSaves()).toHaveLength(0);
    fireEvent.pointerUp(sofa, { clientX: 260, clientY: 100, pointerId: 1 });
    await flush();

    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.furniture[0]?.x).toBe(3);

    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
    expect(roomMapSaves()[1]?.furniture[0]?.x).toBe(1);

    // Nothing left to undo: the drag was one entry, not twenty.
    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
  });
});

describe("RoomMapEditor — a held arrow key is one undo step and one save", () => {
  it("coalesces the auto-repeats and writes once the key goes quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stored({ furniture: [SOFA] });
    const { root } = await renderEditor();
    const sofa = canvasSofa();
    fireEvent.pointerDown(sofa, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(sofa, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(roomMapSaves()).toHaveLength(0);

    fireEvent.keyDown(root, { key: "ArrowRight" });
    // The OS waits before its first auto-repeat.
    act(() => vi.advanceTimersByTime(400));
    for (let i = 0; i < 15; i++) {
      fireEvent.keyDown(root, { key: "ArrowRight", repeat: true });
      act(() => vi.advanceTimersByTime(30));
    }
    fireEvent.keyUp(root, { key: "ArrowRight" });
    expect(roomMapSaves()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS);
    });
    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.furniture[0]?.x).toBeCloseTo(1 + 16 * 0.1, 10);

    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
    expect(roomMapSaves()[1]?.furniture[0]?.x).toBe(1);

    fireEvent.keyDown(root, { key: "z", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
  });
});

// `hue-<index>` names no area, so the dock and the property bar have to read
// the one area the canvas draws. See docs/architecture/room-map.md.
describe("RoomMapEditor — the dock and the property bar show the viewed area only", () => {
  it("lists, inspects and reports the viewed area's channel 0, not another area's", async () => {
    stored(
      {
        tvAnchor: { x: 2, y: 0.3, width: 1, height: 0.1 },
        hueChannels: [
          { channelIndex: 0, x: -0.5, y: 0, z: 0, entertainmentAreaId: "area-a", label: "Lamp A" },
          { channelIndex: 0, x: 0.5, y: 0, z: 0, entertainmentAreaId: "area-b", label: "Lamp B" },
        ],
      },
      { lastHueAreaId: "area-b" },
    );
    await renderEditor();
    await flush();

    expect(screen.queryByText("Lamp A")).toBeNull();
    fireEvent.click(screen.getByText("Lamp B"));

    const x = screen.getByLabelText("roomMap:propertyBar.fields.x") as HTMLInputElement;
    expect(x.value).toBe("0.50");
  });
});

describe("canvas objects are memoised", () => {
  // The editor keeps their callbacks stable so a pan commit re-renders none of
  // them; that is worth nothing if the components themselves are not memos.
  it.each([
    ["FurnitureObject", FurnitureObject],
    ["TvAnchorObject", TvAnchorObject],
    ["UsbStripObject", UsbStripObject],
    ["HueChannelOverlay", HueChannelOverlay],
  ])("%s", (_name, component) => {
    expect((component as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
