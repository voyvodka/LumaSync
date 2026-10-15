import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hueChannelObjectId } from "@/features/room-map/model/objectId";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import RoomView3D, { __closeParkedRoomViewForTests } from "../RoomView3D";

const gl = vi.hoisted(() => ({
  throwOnCreate: false,
  orbits: [] as Array<{ target: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void } }>,
  renderers: [] as Array<{
    domElement: HTMLCanvasElement;
    render: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    domElement = document.createElement("canvas");
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    outputColorSpace = "";
    toneMapping = 0;
    render = vi.fn<() => void>();
    dispose = vi.fn<() => void>();
    forceContextLoss = vi.fn<() => void>();
    setPixelRatio = vi.fn<() => void>();
    setClearColor = vi.fn<() => void>();
    setSize = vi.fn<() => void>();
    getContext = vi.fn<() => void>();
    // Resolved by a timer, as a real compile is, so an unmount can land before it.
    compileAsync = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    constructor() {
      if (gl.throwOnCreate) throw new Error("no WebGL context");
      gl.renderers.push(this);
    }
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  return {
    OrbitControls: class {
      target = new Vector3();
      constructor() {
        gl.orbits.push(this as never);
      }
      update = () => false;
      addEventListener = vi.fn<() => void>();
      maxZoom = 8;
      minZoom = 0.6;
      dispose = vi.fn<() => void>();
    },
  };
});

// The glow pass needs a real context; the fake renderer draws the room straight.
vi.mock("../scene/bloom", () => ({
  BLOOM_LAYER: 1,
  createBloom: (renderer: { render: (...args: unknown[]) => void }) => ({
    render: (scene: unknown, camera: unknown) => renderer.render(scene, camera),
    setSize: () => {},
    dispose: () => {},
  }),
}));

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

describe("RoomView3D", () => {
  let realResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    gl.throwOnCreate = false;
    gl.renderers = [];
    gl.orbits = [];
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    // Unmounted here, before the parked view is closed: the library's own cleanup runs after this.
    cleanup();
    __closeParkedRoomViewForTests();
    vi.useRealTimers();
    globalThis.ResizeObserver = realResizeObserver;
  });

  // A face or stage switch unmounts the view and mounts another: a new context each time paused.
  it("hands its renderer to the next view opened within the park time, drawn at once", async () => {
    const first = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const renderer = gl.renderers[0]!;
    first.unmount();
    expect(renderer.forceContextLoss).not.toHaveBeenCalled();

    const { container, unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} />);
    expect(gl.renderers).toHaveLength(1);
    expect(container.querySelector("canvas")).toBe(renderer.domElement);
    expect(container.querySelector("[data-ready]")).not.toBeNull();
    unmount();
  });

  it("closes a parked view once the park time passes", async () => {
    const { unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const renderer = gl.renderers[0]!;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
  });

  it("hands the context back and never draws when closed before its programs compile", async () => {
    const { unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} />);
    const renderer = gl.renderers[0];

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(renderer?.render).not.toHaveBeenCalled();
    expect(renderer?.dispose).toHaveBeenCalledTimes(1);
    expect(renderer?.forceContextLoss).toHaveBeenCalledTimes(1);
  });

  it("keeps its renderer when the room map changes", () => {
    const onFail = vi.fn<(error: unknown) => void>();
    const { rerender, unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={onFail} />);
    rerender(<RoomView3D config={{ ...DEFAULT_ROOM_MAP, furniture: [] }} label="Room" onFail={onFail} />);

    expect(gl.renderers).toHaveLength(1);
    expect(gl.renderers[0]?.forceContextLoss).not.toHaveBeenCalled();
    unmount();
  });

  // Carrying a piece rebuilt the scene and put the orbit back on the room's middle.
  it("keeps where the view looks when the room's contents change, not its size", () => {
    const onFail = vi.fn<(error: unknown) => void>();
    const { rerender, unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={onFail} />);
    const orbit = gl.orbits[0]!;
    orbit.target.set(1.5, 0.2, -0.8);
    rerender(<RoomView3D config={{ ...DEFAULT_ROOM_MAP, furniture: [] }} label="Room" onFail={onFail} />);
    expect([orbit.target.x, orbit.target.y, orbit.target.z]).toEqual([1.5, 0.2, -0.8]);
    unmount();
  });

  it("draws again when a lost context comes back, and stops listening once closed", async () => {
    const { unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} />);
    const renderer = gl.renderers[0];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const before = renderer?.render.mock.calls.length ?? 0;

    act(() => {
      renderer?.domElement.dispatchEvent(new Event("webglcontextrestored"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(renderer?.render.mock.calls.length).toBe(before + 1);

    unmount();
    renderer?.domElement.dispatchEvent(new Event("webglcontextrestored"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(renderer?.render.mock.calls.length).toBe(before + 1);
  });

  it("reports a missing WebGL context instead of throwing out of the effect", () => {
    gl.throwOnCreate = true;
    const onFail = vi.fn<(error: unknown) => void>();

    expect(() => render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={onFail} />)).not.toThrow();
    expect(onFail).toHaveBeenCalledWith(expect.objectContaining({ message: "no WebGL context" }));
  });

  it("frames a picked light and returns to the room when it is let go", async () => {
    const config = { ...DEFAULT_ROOM_MAP, hueChannels: [{ channelIndex: 0, x: 0.8, y: 0.8, z: 0, zOrigin: "bridge" as const }] };
    const onFail = vi.fn<(error: unknown) => void>();
    const { rerender, unmount } = render(<RoomView3D config={config} label="Room" onFail={onFail} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const target = () => ({ ...gl.orbits[0]!.target });
    const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const before = target();

    rerender(<RoomView3D config={config} label="Room" selectedId={hueChannelObjectId(0)} onFail={onFail} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(distance(target(), before)).toBeGreaterThan(0.3);

    rerender(<RoomView3D config={config} label="Room" selectedId={null} onFail={onFail} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(distance(target(), before)).toBeLessThan(1e-3);
    unmount();
  });

  describe("a click in the room", () => {
    const press = (canvas: HTMLCanvasElement, type: string, x: number, y = 10, button = 0) =>
      canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 1, bubbles: true }));

    const open = () => {
      const onPick = vi.fn<(id: string | null) => void>();
      render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onPick={onPick} onFail={() => {}} />);
      const canvas = gl.renderers[0]?.domElement as HTMLCanvasElement;
      return { onPick, canvas };
    };

    it("is a press that moves less than 3 px", () => {
      const { onPick, canvas } = open();
      press(canvas, "pointerdown", 10);
      press(canvas, "pointerup", 12, 12);
      expect(onPick).toHaveBeenCalledTimes(1);
    });

    // The plan's slop: a trackpad click wobbles a few pixels and is still a click.
    it("is not a drag past 6 px, which turns the room", () => {
      const { onPick, canvas } = open();
      press(canvas, "pointerdown", 10);
      press(canvas, "pointerup", 17);
      expect(onPick).not.toHaveBeenCalled();
    });

    it("is not a secondary button, nor a press the browser cancelled", () => {
      const { onPick, canvas } = open();
      press(canvas, "pointerdown", 10, 10, 2);
      press(canvas, "pointerup", 10, 10, 2);
      press(canvas, "pointerdown", 10);
      press(canvas, "pointercancel", 10);
      press(canvas, "pointerup", 10);
      expect(onPick).not.toHaveBeenCalled();
    });
  });
});

