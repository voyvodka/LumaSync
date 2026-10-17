/**
 * The editor on its real state path — reducer, object components, dock — with
 * only the Tauri boundary and the store file mocked. What these pin is what a
 * gesture costs: undo entries and `shellStore.save` calls.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { GESTURE_COALESCE_MS } from "../../state/roomMapReducer";
import { HueChannelOverlay } from "../HueChannelOverlay";
import { FurnitureObject } from "../objects/FurnitureObject";
import { TvAnchorObject } from "../objects/TvAnchorObject";
import { UsbStripObject } from "../objects/UsbStripObject";
import { RoomMapSurface } from "../RoomMapSurface";

const RoomMapEditor = () => <RoomMapSurface view3dAvailable={false} />;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/features/device/state/localOutputsStore", () => ({
  // Not read yet: the strips' chips read "unknown".
  useLocalOutputs: <S,>(select: (state: { snapshot: null; lastLoss: null }) => S) => select({ snapshot: null, lastLoss: null }),
}));

const store = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  save: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    onSaved: () => () => {},
    load: () => Promise.resolve(store.state),
    save: (partial: Record<string, unknown>) => store.save(partial),
    update: async (fn: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
      const partial = fn(store.state);
      if (partial === null) return store.state;
      store.save(partial);
      store.state = { ...store.state, ...partial };
      return store.state;
    },
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

/** The sofa on the canvas, not its name in the dock. */
function canvasSofa(): HTMLElement {
  const label = screen
    .getAllByText("Sofa")
    .find((el) => el.parentElement?.hasAttribute("data-furniture-id"));
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

    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
    expect(roomMapSaves()[1]?.furniture[0]?.x).toBe(1);

    // Nothing left to undo: the drag was one entry, not twenty.
    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
  });

  // With ⇧ the key reads "Z", so a match on "z" never redid on Windows or Linux.
  it("redoes on ⇧ with the capital the key reports", async () => {
    stored({ furniture: [SOFA] });
    const { root } = await renderEditor();
    const sofa = canvasSofa();
    fireEvent.pointerDown(sofa, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(sofa, { clientX: 260, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(sofa, { clientX: 260, clientY: 100, pointerId: 1 });
    await flush();
    fireEvent.keyDown(root, { key: "z", code: "KeyZ", ctrlKey: true });
    await flush();
    fireEvent.keyDown(root, { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
    await flush();
    const saves = roomMapSaves();
    expect(saves[saves.length - 1]?.furniture[0]?.x).toBe(3);
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

    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
    expect(roomMapSaves()[1]?.furniture[0]?.x).toBe(1);

    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
  });
});

// `hue-<index>` names no area, so the dock and its inspector have to read
// the one area the canvas draws. See docs/architecture/room-map.md.
describe("RoomMapEditor — the dock and its inspector show the viewed area only", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "roomMap:dock.objects" }));
    const list = within(screen.getByRole("dialog", { name: "roomMap:dock.objects" }));
    expect(list.queryByRole("button", { name: "Lamp A" })).toBeNull();
    fireEvent.click(list.getByRole("button", { name: "Lamp B" }));
    expect(screen.queryByText("Lamp A")).toBeNull();

    // Cube x 0.5 is three quarters across the 5 m room; area A's channel 0 would read 1.25.
    const x = screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" }) as HTMLInputElement;
    expect(x.value).toBe("3.75");
  });
});

describe("RoomMapEditor — stepping a typed position is one undo step and one save", () => {
  it("coalesces a run of arrow steps in a Hue light's X field", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stored(
      {
        tvAnchor: { x: 2, y: 0.3, width: 1, height: 0.1 },
        hueChannels: [{ channelIndex: 0, x: 0.5, y: 0, z: 0, entertainmentAreaId: "area-b", label: "Lamp B" }],
      },
      { lastHueAreaId: "area-b" },
    );
    const { root } = await renderEditor();
    await flush();
    // The light's dot on the plan.
    fireEvent.click(screen.getByRole("button", { name: "Lamp B" }));

    const x = screen.getByRole("spinbutton", { name: "roomMap:inspector.xLabel" }) as HTMLInputElement;
    fireEvent.focus(x);
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(x, { key: "ArrowUp" });
      act(() => vi.advanceTimersByTime(60));
    }
    expect(roomMapSaves()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS);
    });
    expect(roomMapSaves()).toHaveLength(1);
    // Five 5 cm steps across a 5 m room are 0.1 of the cube.
    expect(roomMapSaves()[0]?.hueChannels[0]?.x).toBeCloseTo(0.6, 6);

    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()).toHaveLength(2);
    expect(roomMapSaves()[1]?.hueChannels[0]?.x).toBe(0.5);
  });
});

describe("RoomMapEditor — a light chosen as a ceiling light goes up in the same step", () => {
  it("writes the fixture and the height in one save, and one undo takes both back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stored(
      {
        tvAnchor: { x: 2, y: 0.3, width: 1, height: 0.1 },
        hueChannels: [{ channelIndex: 0, x: 0.5, y: 0, z: -1, zOrigin: "user", entertainmentAreaId: "area-b", label: "Lamp B" }],
      },
      { lastHueAreaId: "area-b" },
    );
    const { root } = await renderEditor();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Lamp B" }));

    fireEvent.click(screen.getByRole("button", { name: /^roomMap:inspector\.modelLabel: / }));
    fireEvent.click(screen.getByRole("option", { name: "roomMap:view.family.ceiling" }));
    act(() => vi.advanceTimersByTime(200));
    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS);
    });
    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.hueChannels[0]).toMatchObject({ fixture: "ceiling", z: 1, zOrigin: "user" });

    fireEvent.keyDown(root, { key: "z", code: "KeyZ", metaKey: true });
    await flush();
    expect(roomMapSaves()[1]?.hueChannels[0]).toMatchObject({ z: -1 });
    expect(roomMapSaves()[1]?.hueChannels[0]?.fixture).toBeUndefined();
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

describe("RoomMapEditor — several pieces at once", () => {
  const CHAIR = { id: "chair", type: "chair" as const, x: 3, y: 2, width: 0.6, height: 0.6, label: "Chair" };
  const piece = (id: string) => document.querySelector(`[data-furniture-id="${id}"]`) as HTMLElement;

  it("moves every piece ⇧-clicked into the selection with one drag, as one save", async () => {
    stored({ furniture: [SOFA, CHAIR] });
    await renderEditor();
    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerDown(piece("chair"), { clientX: 300, clientY: 100, pointerId: 2, shiftKey: true });
    fireEvent.pointerUp(piece("chair"), { clientX: 300, clientY: 100, pointerId: 2, shiftKey: true });
    await flush();

    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerMove(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 3, altKey: true });
    fireEvent.pointerUp(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 3, altKey: true });
    await flush();

    const saves = roomMapSaves();
    const last = saves[saves.length - 1];
    expect(roomMapSaves()).toHaveLength(1);
    const sofa = last?.furniture.find((f) => f.id === "sofa");
    const chair = last?.furniture.find((f) => f.id === "chair");
    expect(sofa!.x - SOFA.x).toBeCloseTo(chair!.x - CHAIR.x);
    expect(sofa!.x).toBeGreaterThan(SOFA.x);
  });

  // A desk dragged with its monitor and its strip left both behind: only furniture grouped.
  it("carries the TV and a strip in the selection along with the piece dragged", async () => {
    const TV = { x: 1, y: 0.1, width: 1.2, height: 0.1 };
    const STRIP = { stripId: "s1", startX: 1, startY: 0.2, endX: 2, endY: 0.2, ledCount: 60 };
    const FAR = { stripId: "s2", startX: 0, startY: 3, endX: 1, endY: 3, ledCount: 60 };
    stored({ furniture: [SOFA], tvAnchor: TV, usbStrips: [STRIP, FAR] });
    await renderEditor();
    const tv = document.querySelector('[data-object-id="tv"]') as HTMLElement;
    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.pointerDown(tv, { clientX: 200, clientY: 20, pointerId: 2 });
    fireEvent.pointerUp(tv, { clientX: 200, clientY: 20, pointerId: 2 });
    fireEvent.keyUp(window, { key: "Shift", shiftKey: false });
    await flush();

    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerMove(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 3, altKey: true });
    fireEvent.pointerUp(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 3, altKey: true });
    await flush();

    const saves = roomMapSaves();
    const last = saves[saves.length - 1]!;
    const moved = last.furniture[0]!.x - SOFA.x;
    expect(moved).toBeGreaterThan(0);
    expect(last.tvAnchor!.x - TV.x).toBeCloseTo(moved);
    // The screen's backlight goes with it, as on a drag of the TV alone; a strip elsewhere stays.
    expect(last.usbStrips[0]!.startX - STRIP.startX).toBeCloseTo(moved);
    expect(last.usbStrips[1]!.startX).toBe(FAR.startX);
  });

  it("adds a Hue light and a strip to the selection on a ⇧-click, and drags them along", async () => {
    const STRIP = { stripId: "s1", startX: 3, startY: 3, endX: 4, endY: 3, ledCount: 60 };
    stored(
      { furniture: [SOFA], usbStrips: [STRIP], hueChannels: [{ channelIndex: 0, x: 0.5, y: 0, z: 0, entertainmentAreaId: "area-b", label: "Lamp B" }] },
      { lastHueAreaId: "area-b" },
    );
    await renderEditor();
    await flush();
    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    const dot = screen.getByRole("button", { name: "Lamp B" });
    const strip = document.querySelector('[data-object-id="usb-s1"] line') as Element;
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    for (const [target, pointerId] of [[dot, 2], [strip, 3]] as const) {
      fireEvent.pointerDown(target, { clientX: 200, clientY: 200, pointerId, shiftKey: true });
      fireEvent.pointerUp(target, { clientX: 200, clientY: 200, pointerId, shiftKey: true });
      fireEvent.click(target, { detail: 1, shiftKey: true });
    }
    fireEvent.keyUp(window, { key: "Shift", shiftKey: false });
    await flush();

    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 4 });
    fireEvent.pointerMove(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 4, altKey: true });
    fireEvent.pointerUp(piece("sofa"), { clientX: 180, clientY: 100, pointerId: 4, altKey: true });
    await flush();
    const saves = roomMapSaves();
    const last = saves[saves.length - 1]!;
    expect(last.furniture[0]!.x).toBeGreaterThan(SOFA.x);
    expect(last.hueChannels[0]!.x).toBeGreaterThan(0.5);
    expect(last.usbStrips[0]!.startX).toBeGreaterThan(STRIP.startX);
  });

  it("opens no menu for the selection on a right-click on empty ground", async () => {
    stored({ furniture: [SOFA] });
    await renderEditor();
    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.contextMenu(screen.getByTestId("room-map-object-layer"));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(piece("sofa"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("deletes the whole selection with Delete", async () => {
    stored({ furniture: [SOFA, CHAIR] });
    const { root } = await renderEditor();
    fireEvent.pointerDown(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece("sofa"), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerDown(piece("chair"), { clientX: 300, clientY: 100, pointerId: 2, shiftKey: true });
    fireEvent.pointerUp(piece("chair"), { clientX: 300, clientY: 100, pointerId: 2, shiftKey: true });
    await flush();
    fireEvent.keyDown(root, { key: "Delete", code: "Delete" });
    await flush();
    const saves = roomMapSaves();
    expect(saves[saves.length - 1]?.furniture).toEqual([]);
  });
});

describe("RoomMapEditor — the room's floor and walls", () => {
  // Rust refuses a TV whose centre lies outside the room, and room-aware sampling went quiet.
  it("pushes the TV, pieces and strips back inside when the room is made narrower", async () => {
    stored({
      dimensions: { widthMeters: 6, depthMeters: 4, heightMeters: 2.6 },
      tvAnchor: { x: 4.8, y: 0, width: 1.2, height: 0.1 },
      furniture: [{ ...SOFA, x: 5 }],
      usbStrips: [{ stripId: "s1", startX: 5, startY: 3, endX: 6, endY: 3, ledCount: 60 }],
    });
    await renderEditor();
    fireEvent.click(screen.getByTestId("dock-room"));
    await flush();
    const width = screen.getByTestId("room-width");
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "4" } });
    fireEvent.keyDown(width, { key: "Enter" });
    await flush();
    const saves = roomMapSaves();
    const last = saves[saves.length - 1]!;
    expect(last.dimensions.widthMeters).toBe(4);
    expect(last.tvAnchor!.x + last.tvAnchor!.width).toBeLessThanOrEqual(4);
    expect(last.furniture[0]!.x + last.furniture[0]!.width).toBeLessThanOrEqual(4);
    expect(Math.max(last.usbStrips[0]!.startX, last.usbStrips[0]!.endX)).toBeLessThanOrEqual(4);
  });

  // A newer build's floor must survive this build picking a wall colour.
  it("writes the surface picked over what is stored, keeping a floor it does not know", async () => {
    stored({ furniture: [SOFA], surfaces: { floor: "marble", walls: "sage" } as unknown as RoomMapConfig["surfaces"] });
    await renderEditor();
    fireEvent.click(screen.getByTestId("dock-room"));
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:surfaces.walls.clay" }));
    // Swatch picks are one gesture: the save waits for it to go quiet.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    const saves = roomMapSaves();
    expect(saves[saves.length - 1]?.surfaces).toEqual({ floor: "marble", walls: "clay" });
  });
});

describe("RoomMapEditor — a strip's LED count scrubbed in the inspector", () => {
  // Each step refit the strip from the last one: scrubbed under its corner and back, a bent strip came back straight.
  it("refits every step from the strip as the scrub found it", async () => {
    const BENT = { stripId: "s1", startX: 0.5, startY: 0.5, corners: [{ x: 1.5, y: 0.5 }], endX: 1.5, endY: 1.5, ledCount: 120, ledsPerMeter: 60 };
    stored({ usbStrips: [BENT] });
    await renderEditor();
    const line = document.querySelector('[data-object-id="usb-s1"] line') as Element;
    fireEvent.pointerDown(line, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.click(line, { detail: 1 });
    await flush();

    const box = screen.getByRole("spinbutton", { name: "roomMap:inspector.usbLedCountLabel" }).closest("label")!;
    fireEvent.pointerDown(box, { button: 0, clientX: 400, pointerId: 2 });
    fireEvent.pointerMove(box, { clientX: 40, pointerId: 2 });
    fireEvent.pointerMove(box, { clientX: 400, pointerId: 2 });
    fireEvent.pointerUp(box, { pointerId: 2 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    const saves = roomMapSaves();
    expect(saves[saves.length - 1]!.usbStrips[0]).toMatchObject({ ledCount: 120, corners: [{ x: 1.5, y: 0.5 }], endX: 1.5, endY: 1.5 });
  });
});
