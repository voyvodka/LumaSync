import { act, cleanup, render } from "@testing-library/react";
import type { Mesh, Object3D } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hueChannelObjectId } from "@/features/room-map/model/objectId";
import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import RoomView3D, { __closeParkedRoomViewForTests, type RoomDropTarget } from "../RoomView3D";

const gl = vi.hoisted(() => ({
  throwOnCreate: false,
  orbits: [] as Array<{ object: { zoom: number }; target: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void } }>,
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
      constructor(public object: unknown) {
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

const builds = vi.hoisted(() => ({ count: 0, last: null as unknown, scene: null as Object3D | null, throwNext: false }));
vi.mock("../roomScene", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../roomScene")>();
  return {
    ...actual,
    buildRoomScene: (...args: Parameters<typeof actual.buildRoomScene>) => {
      builds.count++;
      builds.last = args[0];
      if (builds.throwNext) {
        builds.throwNext = false;
        throw new Error("build failed");
      }
      const built = actual.buildRoomScene(...args);
      builds.scene = built.scene;
      return built;
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

  describe("an inspector edit", () => {
    const sofa = { id: "sofa", type: "sofa" as const, x: 1, y: 2, width: 2, height: 0.9 };
    const room = (x: number, width = 2): RoomMapConfig => ({ ...DEFAULT_ROOM_MAP, furniture: [{ ...sofa, x, width }] });
    const families = new Map();
    const rest = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    const open = async (props: Partial<Parameters<typeof RoomView3D>[0]> = {}) => {
      const view = (config: ReturnType<typeof room>, more: Partial<Parameters<typeof RoomView3D>[0]> = {}) => (
        <RoomView3D config={config} lampFamilies={families} label="Room" onFail={() => {}} {...props} {...more} />
      );
      const rendered = render(view(room(1)));
      await rest();
      builds.count = 0;
      return { ...rendered, view };
    };

    // Every step of the inspector's X built the whole room again: ~90 ms a step in a furnished one.
    it("slides a piece in place and builds the latest room once the steps rest", async () => {
      const { rerender, unmount, view } = await open();
      for (let i = 1; i <= 8; i++) rerender(view(room(1 + i * 0.05)));
      expect(builds.count).toBe(0);
      await rest();
      expect(builds.count).toBe(1);
      expect((builds.last as ReturnType<typeof room>).furniture[0]!.x).toBeCloseTo(1.4);
      await rest();
      rerender(view(room(1.4, 2.4)));
      expect(builds.count).toBe(2);
      unmount();
    });

    it("stretches the screen in place while its size steps, and builds the latest once they rest", async () => {
      const furnished = room(1);
      const tv = (width: number) => ({ ...furnished, tvAnchor: { x: 1.5, y: 0, width, height: 0.08 } });
      const { rerender, unmount, view } = await open();
      rerender(view(tv(1.2)));
      await rest();
      builds.count = 0;
      for (let i = 1; i <= 6; i++) rerender(view(tv(1.2 + i * 0.02)));
      expect(builds.count).toBe(0);
      await rest();
      expect(builds.count).toBe(1);
      expect((builds.last as ReturnType<typeof tv>).tvAnchor.width).toBeCloseTo(1.32);
      unmount();
    });

    it("floats a held library card in the room without building it, and takes it away", async () => {
      const dropRef: { current: RoomDropTarget | null } = { current: null };
      const { unmount } = await open({ dropRef });
      const scene = builds.scene!;
      const before = scene.children.length;
      const piece = { id: "library-drop", type: "chair" as const, x: 1, y: 1, width: 0.5, height: 0.5 };
      for (const x of [1, 1.2, 1.4]) dropRef.current!.preview({ piece: { ...piece, x }, model: { kind: "box" }, valid: x < 1.4 });
      expect(scene.children).toHaveLength(before + 1);
      dropRef.current!.preview({ piece, model: null, valid: true });
      expect(scene.children).toHaveLength(before + 1);
      dropRef.current!.preview(null);
      expect(scene.children).toHaveLength(before);
      expect(builds.count).toBe(0);

      // Let go: it sinks onto the floor, then goes.
      dropRef.current!.preview({ piece, model: { kind: "box" }, valid: true });
      dropRef.current!.settle();
      expect(scene.children).toHaveLength(before + 1);
      await rest();
      expect(scene.children).toHaveLength(before);
      unmount();
      expect(dropRef.current).toBeNull();
    });

    it("plays a template out piece by piece in the room it builds at once, and settles into it", async () => {
      const bed = { id: "bed", type: "bed" as const, x: 2, y: 1, width: 1.6, height: 2 };
      const chair = { id: "chair", type: "chair" as const, x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
      const before = { ...room(1), furniture: [{ ...sofa, x: 1 }, bed] };
      const after = { ...room(1), furniture: [{ ...sofa, id: "t-sofa", x: 2.5 }, chair] };
      const { rerender, unmount, view } = await open();
      rerender(view(before));
      await rest();
      builds.count = 0;
      rerender(view(after, { morphKey: 1 }));
      expect(builds.count).toBe(1);
      const scene = builds.scene!;
      // The sofa sliding, the chair rising and the bed going down, each a piece of its own for now.
      const during = scene.children.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(scene.children).toHaveLength(during - 3);
      expect(builds.count).toBe(1);

      // An edit after it is an edit again: the one piece slid in place, as an inspector step does.
      rerender(view({ ...after, furniture: [{ ...sofa, id: "t-sofa", x: 2.6 }, chair] }, { morphKey: 1 }));
      expect(scene.children).toHaveLength(during - 2);
      unmount();
    });

    describe("mid-morph", () => {
      const bed = { id: "bed", type: "bed" as const, x: 2, y: 1, width: 1.6, height: 2 };
      const chair = { id: "chair", type: "chair" as const, x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
      const before = { ...room(1), furniture: [{ ...sofa, x: 1 }, bed] };
      const after = { ...room(1), furniture: [{ ...sofa, id: "t-sofa", x: 2.5 }, chair] };
      const morphing = async () => {
        const opened = await open();
        opened.rerender(opened.view(before));
        await rest();
        opened.rerender(opened.view(after, { morphKey: 1 }));
        const during = builds.scene!.children.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        return { ...opened, during };
      };

      it("ends the morph before a nudge lifts a piece it is still gliding", async () => {
        const { rerender, unmount, view, during } = await morphing();
        rerender(view({ ...after, furniture: [{ ...sofa, id: "t-sofa", x: 2.6 }, chair] }, { morphKey: 1 }));
        expect(builds.scene!.children).toHaveLength(during - 2);
        unmount();
      });

      // Applying the previewed template hands the view a copy of the room it is morphing into.
      it("plays on when handed a copy of the room it is morphing into", async () => {
        const { rerender, unmount, view, during } = await morphing();
        builds.count = 0;
        rerender(view({ ...after }, { morphKey: 2 }));
        expect(builds.count).toBe(0);
        expect(builds.scene!.children).toHaveLength(during);
        unmount();
      });

      it("settles the morph before building again, so nothing of it plays on in the new room", async () => {
        const { rerender, unmount, view, during } = await morphing();
        rerender(view(after, { morphKey: 1, lampFamilies: new Map() }));
        const scene = builds.scene!;
        expect(scene.children).toHaveLength(during - 3);
        const draws = gl.renderers[0]!.render.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
        expect(scene.children).toHaveLength(during - 3);
        // A morph left running would keep posing the old room's pieces, a frame each.
        expect(gl.renderers[0]!.render.mock.calls.length - draws).toBeLessThanOrEqual(2);
        unmount();
      });
    });

    it("lets a slid piece leave a template by sinking, not vanishing", async () => {
      const bed = { id: "bed", type: "bed" as const, x: 2, y: 1, width: 1.6, height: 2 };
      const kept = { ...sofa, x: 1 };
      const { rerender, unmount, view } = await open();
      rerender(view({ ...room(1), furniture: [kept, bed] }));
      await rest();
      rerender(view({ ...room(1), furniture: [kept, { ...bed, x: 2.1 }] }));
      expect(builds.count).toBe(1);
      rerender(view({ ...room(1), furniture: [kept] }, { morphKey: 1 }));
      // A lifted piece is a pivot, a stretch and an inner group around its copies.
      const lifted = builds.scene!.children.filter((child) => child.type === "Group" && child.children[0]?.children[0]?.type === "Group");
      const drawn = (group: (typeof lifted)[number]) => {
        let points = false;
        group.traverse((node) => {
          const geometry = (node as Mesh).isMesh ? (node as Mesh).geometry : null;
          if (geometry && Array.from(geometry.getAttribute("position").array).some((v) => v !== 0)) points = true;
        });
        return points;
      };
      expect(lifted.length).toBeGreaterThan(0);
      expect(lifted.every(drawn)).toBe(true);
      unmount();
    });

    it("waits for the rest with any edit under 200 ms after a build, and builds new fixtures at once", async () => {
      const { rerender, unmount, view } = await open();
      rerender(view(room(1, 2.2)));
      expect(builds.count).toBe(1);
      rerender(view(room(1, 2.4)));
      expect(builds.count).toBe(1);
      await rest();
      expect(builds.count).toBe(2);
      rerender(view(room(1.2, 2.4)));
      rerender(view(room(1.2, 2.4), { lampFamilies: new Map([[0, "bulb" as const]]) }));
      expect(builds.count).toBe(3);
      unmount();
    });

    it("builds a waiting room at once when the room is pressed, so a carry lifts from it", async () => {
      const { container, rerender, unmount, view } = await open({ onMovePiece: () => true });
      rerender(view(room(1.3)));
      expect(builds.count).toBe(0);
      container.querySelector("canvas")!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 5, clientY: 5, bubbles: true }));
      expect(builds.count).toBe(1);
      unmount();
    });

    it("reports a waiting build that fails, as an immediate one is", async () => {
      const onFail = vi.fn<(error: unknown) => void>();
      const { rerender, unmount, view } = await open({ onFail });
      rerender(view(room(1.3)));
      builds.throwNext = true;
      await rest();
      expect(onFail).toHaveBeenCalledWith(expect.objectContaining({ message: "build failed" }));
      unmount();
    });

    it("builds nothing once closed with a build waiting", async () => {
      const { rerender, unmount, view } = await open();
      rerender(view(room(1.3)));
      unmount();
      __closeParkedRoomViewForTests();
      await rest();
      expect(builds.count).toBe(0);
    });
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

  // A template looked at while a light was picked: dropping the pick took the camera back to the old room's view.
  it("keeps a template's camera when its preview drops the pick, and frames the light once on the way back", async () => {
    const config = { ...DEFAULT_ROOM_MAP, hueChannels: [{ channelIndex: 0, x: 0.8, y: 0.8, z: 0, zOrigin: "bridge" as const }] };
    const template = { ...DEFAULT_ROOM_MAP, dimensions: { ...DEFAULT_ROOM_MAP.dimensions, widthMeters: DEFAULT_ROOM_MAP.dimensions.widthMeters + 2 } };
    const onFail = vi.fn<(error: unknown) => void>();
    const view = (room: RoomMapConfig, selectedId: string | null, morphKey: number) => (
      <RoomView3D config={room} label="Room" selectedId={selectedId} morphKey={morphKey} onFail={onFail} />
    );
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    const { rerender, unmount } = render(view(config, null, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const camera = gl.orbits[0]!.object;
    rerender(view(config, hueChannelObjectId(0), 0));
    await settle();
    const framed = camera.zoom;

    rerender(view(template, null, 1));
    const shown = camera.zoom;
    await settle();
    expect(camera.zoom).toBeCloseTo(shown);

    rerender(view(config, hueChannelObjectId(0), 2));
    await settle();
    expect(camera.zoom).toBeCloseTo(framed);
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

    // A view handed to the next face must answer that face: the first one's handlers are gone.
    it("reaches the face that adopted the view, not the one that parked it", async () => {
      const first = vi.fn<(id: string | null) => void>();
      const parked = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onPick={first} onFail={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      parked.unmount();
      const second = vi.fn<(id: string | null) => void>();
      render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onPick={second} onFail={() => {}} />);
      const canvas = gl.renderers[0]?.domElement as HTMLCanvasElement;
      expect(gl.renderers).toHaveLength(1);
      press(canvas, "pointerdown", 10);
      press(canvas, "pointerup", 10);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
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

