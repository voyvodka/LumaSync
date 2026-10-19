import { act, cleanup, render } from "@testing-library/react";
import { type Camera, type Mesh, type Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planMetresToHue } from "@/features/room-map/model/hueChannelPosition";
import { pieceUnder } from "@/features/room-map/model/lightSeat";
import { hueChannelObjectId } from "@/features/room-map/model/objectId";
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { ZoneRect } from "@/features/room-map/model/zoneRect";
import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import RoomView3D, { __closeParkedRoomViewForTests, parkedViewReady, type RoomDropTarget } from "../RoomView3D";

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

const builds = vi.hoisted(() => ({
  count: 0,
  last: null as unknown,
  scene: null as Object3D | null,
  moods: [] as Array<readonly number[] | undefined>,
  throwNext: false,
}));
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
      const setMood = built.setMood.bind(built);
      built.setMood = (...mood: Parameters<typeof built.setMood>) => {
        builds.moods.push(mood[2]);
        return setMood(...mood);
      };
      return built;
    },
  };
});

// The glow pass needs a real context; the fake renderer draws the room straight.
vi.mock("../scene/bloom", () => ({
  BLOOM_LAYER: 1,
  OVERLAY: "overlay",
  createBloom: (renderer: { render: (...args: unknown[]) => void; compileAsync: (...args: unknown[]) => Promise<void> }) => ({
    render: (scene: unknown, camera: unknown) => renderer.render(scene, camera),
    compile: (scene: unknown, camera: unknown) => renderer.compileAsync(scene, camera),
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

  it("says when its first frame is drawn, and at once when it adopts a drawn view", async () => {
    // A sized host: the view draws nothing into a box with no size.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
    const onDrawn = vi.fn<() => void>();
    const first = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} onDrawn={onDrawn} />);
    expect(onDrawn).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onDrawn).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(parkedViewReady()).toBe(true);

    const adopted = vi.fn<() => void>();
    const { unmount } = render(<RoomView3D config={DEFAULT_ROOM_MAP} label="Room" onFail={() => {}} onDrawn={adopted} />);
    expect(adopted).toHaveBeenCalledTimes(1);
    expect(onDrawn).toHaveBeenCalledTimes(1);
    unmount();
    rect.mockRestore();
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

    it("frees the room it replaced only once the new one is drawn", async () => {
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
      const { rerender, unmount, view } = await open();
      const old = builds.scene!;
      const disposed = vi.fn<() => void>();
      old.traverse((node) => {
        const material = (node as Mesh).material;
        if (material && !Array.isArray(material)) material.addEventListener("dispose", disposed);
      });
      rerender(view(room(1.4, 2.4)));
      expect(builds.count).toBe(1);
      expect(disposed).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(disposed).toHaveBeenCalled();
      unmount();
      rect.mockRestore();
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

  // A lamp then a sofa flew the camera home under a carry about to start; a turn mid-travel was undone every frame.
  it("leaves the camera on a furniture pick, and lets a hand take it mid-travel", async () => {
    const config = {
      ...DEFAULT_ROOM_MAP,
      furniture: [{ id: "sofa", type: "sofa" as const, x: 1, y: 2, width: 2, height: 0.9 }],
      hueChannels: [{ channelIndex: 0, x: 0.8, y: 0.8, z: 0, zOrigin: "bridge" as const }],
    };
    const onFail = vi.fn<(error: unknown) => void>();
    const view = (selectedId: string | null) => <RoomView3D config={config} label="Room" selectedId={selectedId} onFail={onFail} />;
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    const { rerender, unmount } = render(view(null));
    await settle();
    const orbit = gl.orbits[gl.orbits.length - 1]! as unknown as { object: { zoom: number }; addEventListener: { mock: { calls: unknown[][] } } };
    const fire = (type: string) => {
      for (const [name, handler] of orbit.addEventListener.mock.calls) if (name === type) (handler as () => void)();
    };
    const room = orbit.object.zoom;
    rerender(view(hueChannelObjectId(0)));
    await settle();
    const framed = orbit.object.zoom;
    rerender(view("furniture-sofa"));
    await settle();
    expect(orbit.object.zoom).toBeCloseTo(framed);

    rerender(view(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    fire("start");
    const held = orbit.object.zoom;
    await settle();
    fire("end");
    expect(orbit.object.zoom).toBeCloseTo(held);
    expect(held).not.toBeCloseTo(room);
    unmount();
  });

  it("frames the next light from the room's view after a click, and forgets it only when the room is turned", async () => {
    const config = {
      ...DEFAULT_ROOM_MAP,
      hueChannels: [
        { channelIndex: 0, x: 0.8, y: 0.8, z: 0, zOrigin: "bridge" as const },
        { channelIndex: 1, x: -0.8, y: 0.8, z: 0, zOrigin: "bridge" as const },
      ],
    };
    const onFail = vi.fn<(error: unknown) => void>();
    const view = (selectedId: string | null) => <RoomView3D config={config} label="Room" selectedId={selectedId} onFail={onFail} />;
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    const { rerender, unmount } = render(view(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const orbit = gl.orbits[0]! as unknown as { object: { zoom: number }; addEventListener: { mock: { calls: unknown[][] } } };
    const fire = (type: string) => {
      for (const [name, handler] of orbit.addEventListener.mock.calls) if (name === type) (handler as () => void)();
    };
    const room = orbit.object.zoom;
    rerender(view(hueChannelObjectId(0)));
    await settle();
    const framed = orbit.object.zoom;
    expect(framed).toBeGreaterThan(room);

    fire("start");
    fire("end");
    rerender(view(hueChannelObjectId(1)));
    await settle();
    expect(orbit.object.zoom).toBeCloseTo(framed);

    fire("start");
    fire("change");
    fire("end");
    rerender(view(null));
    await settle();
    expect(orbit.object.zoom).toBeCloseTo(framed);
    unmount();
  });

  // Solid to an effect: the lamps took the effect's colours at once while the light eased in.
  it("eases each lamp's colour into an effect's palette", async () => {
    const onFail = vi.fn<(error: unknown) => void>();
    const solid = { level: 1, ambient: 1, strip: 1, daylight: 0.3, brightness: 1, lamp: 0xff0000, sky: { top: 0, mid: 0 } };
    const effect = { ...solid, lamp: 0x008080, palette: [0x00ff00, 0x0000ff] };
    const view = (mood: typeof solid) => <RoomView3D config={DEFAULT_ROOM_MAP} label="Room" mood={mood} onFail={onFail} />;
    const { rerender, unmount } = render(view(solid));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    builds.moods.length = 0;
    rerender(view(effect));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    const midway = builds.moods[builds.moods.length - 1];
    expect(midway).toHaveLength(2);
    expect(midway![0]).not.toBe(0x00ff00);
    expect(midway![0]).not.toBe(0xff0000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(builds.moods[builds.moods.length - 1]).toEqual([0x00ff00, 0x0000ff]);
    unmount();
  });

  // Plan and back to 3D zoomed in once more each time: the standing command ran again on the mount.
  it("does not replay a zoom pressed before the view came back", async () => {
    const onFail = vi.fn<(error: unknown) => void>();
    const command = { kind: "in" as const, seq: 1 };
    const view = (cameraCommand?: typeof command) => (
      <RoomView3D config={DEFAULT_ROOM_MAP} label="Room" selectedId={null} cameraCommand={cameraCommand} onFail={onFail} />
    );
    const settle = () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    const first = render(view());
    await settle();
    first.rerender(view(command));
    await settle();
    const camera = gl.orbits[gl.orbits.length - 1]!.object;
    const zoomed = camera.zoom;
    first.unmount();
    const again = render(view(command));
    await settle();
    expect(gl.orbits[gl.orbits.length - 1]!.object.zoom).toBeCloseTo(zoomed);
    again.unmount();
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

  describe("a Hue zone", () => {
    // A 1 m cube at the middle of a 6 × 4 × 2.5 m room: x 2.5–3.5, y 1.5–2.5 on the plan, 0.75–1.75 m
    // high. A room size no other test opens, so the camera kept for the session from one of them is
    // not reused.
    const zone: HueZone = { id: "a", name: "Sofa", entertainmentAreaId: "x", centerX: 0, centerY: 0, centerZ: 0, scaleX: 1 / 6, scaleY: 0.25, scaleZ: 0.4, channelIndices: [] };
    const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: { widthMeters: 6, depthMeters: 4, heightMeters: 2.5 }, zones: [zone] };
    const HELD: ZoneMarks = { active: "a", held: "a", others: [] };

    const open = async (zones: ZoneMarks) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400));
      const onPick = vi.fn<(id: string | null) => void>();
      const onPickZone = vi.fn<(zoneId: string) => void>();
      const onChangeZone = vi.fn<(zoneId: string, rect: ZoneRect, resized: boolean, centerZ: number) => boolean>(() => true);
      render(<RoomView3D config={config} label="Room" zones={zones} onPick={onPick} onPickZone={onPickZone} onChangeZone={onChangeZone} onFail={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const canvas = gl.renderers[0]?.domElement as HTMLCanvasElement;
      const camera = gl.orbits[0]!.object as unknown as Camera;
      const at = (x: number, y: number, height = 0) => {
        // The fake renderer never draws, so nothing else brings the camera's matrices up to date.
        camera.updateMatrixWorld();
        const p = new Vector3(x - 3, height, y - 2).project(camera);
        return { x: ((p.x + 1) / 2) * 400, y: ((1 - p.y) / 2) * 400 };
      };
      const press = (type: string, p: { x: number; y: number }, shiftKey = false) =>
        canvas.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, pointerId: 1, bubbles: true, shiftKey }));
      return { onPick, onPickZone, onChangeZone, at, press };
    };

    afterEach(() => vi.restoreAllMocks());

    it("is carried whole from its floor, and written once when let go", async () => {
      const { onChangeZone, at, press } = await open(HELD);
      press("pointerdown", at(3, 2));
      press("pointermove", at(3.25, 2.25));
      press("pointermove", at(3.5, 2.5));
      expect(onChangeZone).not.toHaveBeenCalled();
      press("pointerup", at(3.5, 2.5));
      expect(onChangeZone).toHaveBeenCalledTimes(1);
      const [id, rect, resized] = onChangeZone.mock.calls[0]!;
      expect([id, resized]).toEqual(["a", false]);
      expect(rect.x0).toBeCloseTo(3);
      expect(rect.y1).toBeCloseTo(3);
      expect(rect.x1 - rect.x0).toBeCloseTo(1);
    });

    it("is resized from a corner grip", async () => {
      const { onChangeZone, at, press } = await open(HELD);
      press("pointerdown", at(3.5, 2.5));
      press("pointermove", at(4, 3.2));
      press("pointerup", at(4, 3.2));
      const [, rect, resized] = onChangeZone.mock.calls[0]!;
      expect(resized).toBe(true);
      expect(rect.x0).toBeCloseTo(2.5);
      expect(rect.y0).toBeCloseTo(1.5);
      // It stays square: the deeper pull, 1.7 m, sets the edge.
      expect(rect.x1).toBeCloseTo(4.2);
      expect(rect.y1).toBeCloseTo(3.2);
      // Its bottom stays at -0.4 as it grows to 0.68 of the room's height, so the top rises instead.
      expect(onChangeZone.mock.calls[0]![3]).toBeCloseTo(0.28);
    });

    it("rises with ⇧ from where it was gripped, its floor left where it is", async () => {
      const { onChangeZone, at, press } = await open(HELD);
      press("pointerdown", at(3, 2));
      press("pointermove", at(3, 2, 0.5), true);
      press("pointermove", at(3, 2, 1), true);
      press("pointerup", at(3, 2, 1), true);
      const [, rect, resized, centerZ] = onChangeZone.mock.calls[0]!;
      expect(resized).toBe(false);
      expect([rect.x0, rect.y0, rect.x1, rect.y1].map((v) => Number(v.toFixed(6)))).toEqual([2.5, 1.5, 3.5, 2.5]);
      // Half a metre up: its centre from 1.25 m to 1.75 m of 2.5 m.
      expect(centerZ).toBeCloseTo(0.4);
    });

    it("stops rising where its top meets the ceiling", async () => {
      const { onChangeZone, at, press } = await open(HELD);
      press("pointerdown", at(3, 2));
      press("pointermove", at(3, 2, 0.5), true);
      press("pointermove", at(3, 2, 3), true);
      press("pointerup", at(3, 2, 3), true);
      expect(onChangeZone.mock.calls[0]![3]).toBeCloseTo(0.6);
    });

    it("goes back where it was on Esc, writing nothing", async () => {
      const { onChangeZone, at, press } = await open(HELD);
      press("pointerdown", at(3, 2));
      press("pointermove", at(3.5, 2.5));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      press("pointerup", at(3.5, 2.5));
      expect(onChangeZone).not.toHaveBeenCalled();
    });

    // A zone only shown for a selected light: a drag over it turns the room, as one over any other floor.
    it("is not carried unless it is itself the selection", async () => {
      const { onChangeZone, at, press } = await open({ active: "a", held: null, others: [] });
      press("pointerdown", at(3, 2));
      press("pointermove", at(3.5, 2.5));
      press("pointerup", at(3.5, 2.5));
      expect(onChangeZone).not.toHaveBeenCalled();
    });

    it("is picked where a click finds only its floor, and the room's empty floor picks nothing", async () => {
      const { onPick, onPickZone, at, press } = await open({ active: null, held: null, others: ["a"] });
      press("pointerdown", at(2.75, 2));
      press("pointerup", at(2.75, 2));
      expect(onPickZone).toHaveBeenCalledWith("a");
      expect(onPick).not.toHaveBeenCalled();
      press("pointerdown", at(0.5, 0.5));
      press("pointerup", at(0.5, 0.5));
      expect(onPick).toHaveBeenCalledWith(null);
    });
  });
  describe("a carried piece", () => {
    // A 1 × 0.6 m sofa in a 5.5 × 3.5 m room no other test opens, its right side 3 cm off the wall at 5.5.
    const sofa = { id: "s", type: "sofa" as const, x: 2, y: 1.5, width: 1, height: 0.6 };
    const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: { widthMeters: 5.5, depthMeters: 3.5, heightMeters: 2.5 }, furniture: [sofa], tvAnchor: undefined, hueChannels: [] };

    const open = async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400));
      const onMovePiece = vi.fn<(id: string, x: number, z: number) => boolean>(() => true);
      render(<RoomView3D config={config} label="Room" selectedId="furniture-s" onPick={() => {}} onMovePiece={onMovePiece} onFail={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const canvas = gl.renderers[0]?.domElement as HTMLCanvasElement;
      const camera = gl.orbits[0]!.object as unknown as Camera;
      const at = (x: number, y: number, height: number) => {
        camera.updateMatrixWorld();
        const p = new Vector3(x - 2.75, height, y - 1.75).project(camera);
        return { x: ((p.x + 1) / 2) * 400, y: ((1 - p.y) / 2) * 400 };
      };
      const press = (type: string, p: { x: number; y: number }, altKey = false) =>
        canvas.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, pointerId: 1, bubbles: true, altKey }));
      return { onMovePiece, at, press };
    };

    afterEach(() => vi.restoreAllMocks());

    it("goes flush against the wall it is brought to", async () => {
      const { onMovePiece, at, press } = await open();
      press("pointerdown", at(2.5, 1.8, 0.2));
      press("pointermove", at(3.5, 1.8, 0.2));
      // Its right side 3 cm short of the wall at 5.5.
      press("pointermove", at(4.97, 1.8, 0.2));
      press("pointerup", at(4.97, 1.8, 0.2));
      // Its middle half a metre in from the wall: 5 on the plan, 2.25 in the scene.
      expect(onMovePiece.mock.calls[0]![1]).toBeCloseTo(2.25);
    });

    it("moves free while ⌥ is held", async () => {
      const { onMovePiece, at, press } = await open();
      press("pointerdown", at(2.5, 1.8, 0.2));
      press("pointermove", at(3.5, 1.8, 0.2), true);
      press("pointermove", at(4.97, 1.8, 0.2), true);
      press("pointerup", at(4.97, 1.8, 0.2), true);
      expect(onMovePiece.mock.calls[0]![1]).toBeCloseTo(2.22, 1);
      expect(onMovePiece.mock.calls[0]![1]).toBeLessThan(2.24);
    });
  });

  describe("a carried light", () => {
    // A bulb on the floor 5 cm up, and a desk it is carried onto.
    const desk = { id: "desk", type: "table" as const, variant: "desk" as const, x: 1, y: 1, width: 1.2, height: 0.6 };
    const dims = { widthMeters: 5.5, depthMeters: 3.5, heightMeters: 2.5 };
    const bulb = { channelIndex: 0, ...planMetresToHue(3, 2.5, 5.5, 3.5), z: (0.05 / 2.5) * 2 - 1, zOrigin: "bridge" as const };
    const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: dims, furniture: [desk], tvAnchor: undefined, hueChannels: [bulb] };

    afterEach(() => vi.restoreAllMocks());

    it("stands on the desk it is carried over before it is let go, and is named standing there", async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400));
      render(<RoomView3D config={config} label="Room" selectedId={hueChannelObjectId(0)} onPick={() => {}} onMovePiece={() => true} onFail={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const canvas = gl.renderers[0]?.domElement as HTMLCanvasElement;
      const camera = gl.orbits[0]!.object as unknown as Camera;
      const scene = builds.scene!;
      const lit = scene.getObjectsByProperty("type", "LineSegments").length;
      const at = (x: number, y: number) => {
        camera.updateMatrixWorld();
        const p = new Vector3(x - 2.75, 0.05, y - 1.75).project(camera);
        return { clientX: ((p.x + 1) / 2) * 400, clientY: ((1 - p.y) / 2) * 400, button: 0, pointerId: 1, bubbles: true };
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", at(3, 2.5)));
      canvas.dispatchEvent(new PointerEvent("pointermove", at(2.5, 2)));
      const ghost = scene.getObjectsByProperty("type", "LineSegments")[lit]!;
      const floorY = ghost.position.y;
      canvas.dispatchEvent(new PointerEvent("pointermove", at(1.6, 1.3)));
      expect(ghost.position.y - floorY).toBeCloseTo(pieceUnder(config, 1.6, 1.3)!.top);
      expect(scene.getObjectByName("snap-guides")?.visible).toBe(true);
      canvas.dispatchEvent(new PointerEvent("pointermove", at(2.5, 2)));
      expect(ghost.position.y).toBeCloseTo(floorY);
    });
  });
});

