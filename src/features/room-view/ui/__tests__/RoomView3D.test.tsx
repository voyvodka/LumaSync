import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import RoomView3D from "../RoomView3D";

const gl = vi.hoisted(() => ({
  throwOnCreate: false,
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
      update = () => false;
      addEventListener = vi.fn<() => void>();
      dispose = vi.fn<() => void>();
    },
  };
});

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
    realResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof globalThis.ResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = realResizeObserver;
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

    it("is not a drag of 3 px or more, which turns the room", () => {
      const { onPick, canvas } = open();
      press(canvas, "pointerdown", 10);
      press(canvas, "pointerup", 14);
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

