// Spike: the 3D room, measured in the real app before the room view is built for real. Draws only
// on a change, and hands back everything — context included — on unmount. The rules it follows are
// in docs/architecture/ui-and-shell.md, "Per-window bundles".
import { useEffect, useRef } from "react";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  NeutralToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import type { LampFamily } from "../model/lampFamily";
import { pressStartsCarry } from "../model/carryIntent";
import { lightPickHalf, pickObject } from "../model/picking";
import { prefersReducedMotion } from "@/shared/lib/motion";

import { buildRoomScene, disposeScene, type RoomScene, type RoomSceneOptions } from "./roomScene";
import styles from "./RoomView3D.module.css";

/** What a measuring run varies; absent fields take the defaults below. */
interface SpikeOptions extends Partial<RoomSceneOptions> {
  antialias?: boolean;
  pixelRatio?: number;
  /** Compile every program off the first frame's path with `compileAsync` (default on). */
  asyncCompile?: boolean;
  /** Shrink the canvas to 1×1 after the context is lost, so WebKit drops its buffers at once. */
  shrinkOnClose?: boolean;
}

interface Timings {
  options: SpikeOptions;
  openMs: number;
  compileMs: number;
  firstFrameMs: number;
  firstFrameAt: number;
  draws: number[];
}

declare global {
  interface Window {
    __roomViewSpike?: Timings;
    __roomViewSpikeOptions?: SpikeOptions;
    /** Turns the camera `n` steps around the room, drawing each; mean ms without and with a GPU sync. */
    __roomViewSpikeBench?: (n: number) => { perDrawMs: number; perDrawFinishedMs: number };
  }
}

interface RoomView {
  show(config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>): void;
  select(objectId: string | null): void;
  /** Pixels at the foot and the head something floats over; the room is fitted between them. */
  setInsets(bottom: number, top: number): void;
  /** The camera's own controls, beside the drag and the wheel. */
  camera(command: CameraCommand["kind"]): void;
  close(): void;
}

/** A press on the view's corner controls; `seq` makes the same press twice two commands. */
export interface CameraCommand {
  kind: "in" | "out" | "reset";
  seq: number;
}

const ZOOM_STEP = 1.25;
/**
 * Where the camera was, kept for the session: switching to the plan and back reopens the room as
 * it was left instead of from the default corner. For the same room size only.
 */
let sessionCamera: { position: Vector3; target: Vector3; zoom: number; room: string } | null = null;
const roomKey = (config: RoomMapConfig) => `${config.dimensions.widthMeters}x${config.dimensions.depthMeters}`;
/** The frame of a piece being carried: the app's amber. */
const CARRY_COLOUR = 0xffb020;
/** A camera move from the corner buttons or a double-click: short and settling, as the app's
 *  motion is (`--lm-dur-slow`, an ease-out); a jump read as the view breaking. */
const CAMERA_MOVE_MS = 320;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

const POLAR = 0.95;
/** A press that moves further than this turns the room; one that stays within it is a click (the
 *  plan's rule, `CLICK_SLOP_PX` in snapGeometry.ts, so a nudge while clicking a lamp does not throw
 *  the selection away). */
const CLICK_SLOP_PX = 6;

/** The renderer, camera and controls live as long as the view; a room-map change swaps only the
 *  scene. Throws when no WebGL context can be had. */
function openRoomView(
  host: HTMLElement,
  onFail: (error: unknown) => void,
  onPick: (objectId: string | null) => void,
  onMovePiece: ((objectId: string, sceneX: number, sceneZ: number, turnDeg: number) => void) | null,
): RoomView {
  const options: SpikeOptions = window.__roomViewSpikeOptions ?? {};
  const started = performance.now();
  const timings: Timings = { options, openMs: 0, compileMs: 0, firstFrameMs: 0, firstFrameAt: 0, draws: [] };
  window.__roomViewSpike = timings;

  // Measured: MSAA added ~50 MB to the page process at 2×, where the pixel density already
  // smooths the edges, so it is on only for a 1× screen.
  const pixelRatio = Math.min(window.devicePixelRatio, options.pixelRatio ?? 2);
  // Transparent, so the view's night backdrop (a CSS gradient) shows behind the room.
  const renderer = new WebGLRenderer({ antialias: options.antialias ?? pixelRatio < 2, alpha: true });
  let closed = false;
  let room: RoomScene | null = null;
  let frame = 0;
  let observer: ResizeObserver | null = null;
  let controls: OrbitControls | null = null;
  let selected: string | null = null;
  let pixelsPerMetre = 0;
  let bottomInset = 0;
  let topInset = 0;
  const listening = new AbortController();

  const close = () => {
    if (closed) return;
    closed = true;
    listening.abort();
    delete window.__roomViewSpikeBench;
    observer?.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
    controls?.dispose();
    if (room) disposeScene(room.scene);
    renderer.dispose();
    renderer.forceContextLoss();
    // Measured: without this WebKit kept ~120 MB in its GPU process after the view closed,
    // until something else collected the canvas.
    if (options.shrinkOnClose ?? true) {
      renderer.domElement.width = 1;
      renderer.domElement.height = 1;
    }
    renderer.domElement.remove();
  };

  try {
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    const shadows = options.shadows ?? true;
    renderer.shadowMap.enabled = shadows;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    host.appendChild(renderer.domElement);

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const orbit = new OrbitControls(camera, renderer.domElement);
    controls = orbit;
    orbit.minPolarAngle = 0.6;
    orbit.maxPolarAngle = 1.2;
    // A right drag (two fingers on a trackpad with the button) moves what the room turns about, and
    // the wheel zooms toward the pointer: the view is no longer pinned to the room's middle.
    orbit.enablePan = true;
    orbit.screenSpacePanning = true;
    orbit.zoomToCursor = true;
    orbit.minZoom = 0.6;
    orbit.maxZoom = 8;
    orbit.enableDamping = !prefersReducedMotion();

    const placeCamera = (current: RoomScene, azimuth: number) => {
      const distance = current.radius * 4;
      camera.position.set(
        current.target.x + distance * Math.sin(POLAR) * Math.sin(azimuth),
        current.target.y + distance * Math.cos(POLAR),
        current.target.z + distance * Math.sin(POLAR) * Math.cos(azimuth),
      );
      camera.lookAt(current.target);
    };
    const direction = new Vector3();
    const cut = (current: RoomScene) => {
      direction.subVectors(camera.position, current.target).setY(0).normalize();
      if (current.cutWalls(direction) && shadows) renderer.shadowMap.needsUpdate = true;
    };

    let ready = false;
    const draw = () => {
      frame = 0;
      if (!room) return;
      const t0 = performance.now();
      // Damping moves the camera a little on every update; keep drawing only while it does.
      const moving = orbit.update();
      cut(room);
      pixelsPerMetre = host.clientHeight / ((camera.top - camera.bottom) / camera.zoom);
      room.setPixelsPerMetre(pixelsPerMetre);
      room.faceCamera(camera.quaternion);
      renderer.render(room.scene, camera);
      const now = performance.now();
      if (timings.firstFrameMs === 0) {
        timings.firstFrameAt = now;
        timings.firstFrameMs = now - started;
        host.setAttribute("data-ready", "");
      }
      timings.draws.push(now - t0);
      if (moving) request();
    };
    const request = () => {
      if (ready && frame === 0 && !closed) frame = requestAnimationFrame(draw);
    };
    let shownRoom = "";
    orbit.addEventListener("change", () => {
      request();
      if (shownRoom) {
        sessionCamera = { position: camera.position.clone(), target: orbit.target.clone(), zoom: camera.zoom, room: shownRoom };
      }
    });
    // A lost context (the GPU reset, the machine slept) comes back empty. three uploads the scene
    // again on the next draw, but a view that draws only on a change has to be asked for one.
    renderer.domElement.addEventListener(
      "webglcontextrestored",
      () => {
        renderer.shadowMap.needsUpdate = shadows;
        request();
      },
      { signal: listening.signal },
    );

    // One move at a time, from wherever the camera is now: a second press during a move carries on
    // from there instead of jumping to the end of the first.
    let move = 0;
    const moveCamera = (to: { zoom: number; target?: Vector3; position?: Vector3 }) => {
      if (move !== 0) cancelAnimationFrame(move);
      const zoom0 = camera.zoom;
      const target0 = orbit.target.clone();
      const position0 = camera.position.clone();
      const apply = (k: number) => {
        camera.zoom = zoom0 + (to.zoom - zoom0) * k;
        if (to.target) orbit.target.lerpVectors(target0, to.target, k);
        if (to.position) camera.position.lerpVectors(position0, to.position, k);
        camera.updateProjectionMatrix();
        orbit.update();
        request();
      };
      if (prefersReducedMotion()) {
        apply(1);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - start) / CAMERA_MOVE_MS, 1);
        apply(easeOut(t));
        move = t < 1 && !closed ? requestAnimationFrame(step) : 0;
      };
      move = requestAnimationFrame(step);
    };

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let press: { x: number; y: number; id: number } | null = null;
    const canvas = renderer.domElement;
    const floor = new Plane(new Vector3(0, 1, 0), 0);
    const onFloor = new Vector3();
    const rayAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.ray;
    };
    // A piece pressed on is carried over the floor: a frame shows where it will stand, and it is
    // put there on release. A press on anything else turns the room as before.
    let carry: { id: string; dx: number; dz: number; ghost: LineSegments; moved: boolean; turn: number; angle: number } | null = null;
    // While a piece is carried, the wheel or R turns it in 15° steps (⇧ turns the other way).
    const turnCarry = (by: number) => {
      if (!carry) return;
      carry.turn = (((carry.turn + by) % 360) + 360) % 360;
      carry.moved = true;
      carry.ghost.visible = true;
      carry.ghost.rotation.y = -(carry.angle + (carry.turn * Math.PI) / 180);
      request();
    };
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (!carry) return;
        event.preventDefault();
        turnCarry(event.deltaY > 0 ? 15 : -15);
      },
      { signal: listening.signal, passive: false },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (!carry || event.key !== "Escape") return;
        // Put down where it was picked up: nothing is written.
        event.preventDefault();
        event.stopPropagation();
        if (press && canvas.hasPointerCapture(press.id)) canvas.releasePointerCapture(press.id);
        press = null;
        drop(false);
      },
      { signal: listening.signal, capture: true },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (!carry || (event.key !== "r" && event.key !== "R")) return;
        event.preventDefault();
        turnCarry(event.shiftKey ? -15 : 15);
      },
      { signal: listening.signal },
    );
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        press = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
        if (!press || !room || !onMovePiece) return;
        const ray = rayAt(event.clientX, event.clientY);
        const id = pickObject(ray, room.pickables, lightPickHalf(pixelsPerMetre));
        const item = id ? room.pickables.find((p) => p.id === id) : undefined;
        if (!id || !item || !pressStartsCarry(item, selected) || !ray.intersectPlane(floor, onFloor)) return;
        const [hx, hy, hz] = item.half;
        const ghost = new LineSegments(
          new EdgesGeometry(new BoxGeometry(hx * 2, Math.max(hy * 2, 0.05), hz * 2)),
          new LineBasicMaterial({ color: CARRY_COLOUR }),
        );
        ghost.position.set(item.centre.x, Math.max(hy, 0.025), item.centre.z);
        ghost.rotation.y = -item.angle;
        ghost.visible = false;
        room.scene.add(ghost);
        carry = { id, dx: item.centre.x - onFloor.x, dz: item.centre.z - onFloor.z, ghost, moved: false, turn: 0, angle: item.angle };
        orbit.enabled = false;
        canvas.setPointerCapture(event.pointerId);
      },
      { signal: listening.signal },
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!carry && !press && room && onMovePiece) {
          // The selected piece says it can be picked up; nothing else changes the cursor.
          const hovered = pickObject(rayAt(event.clientX, event.clientY), room.pickables, lightPickHalf(pixelsPerMetre));
          const item = hovered ? room.pickables.find((p) => p.id === hovered) : undefined;
          canvas.style.cursor = pressStartsCarry(item, selected) ? "grab" : "";
          return;
        }
        if (!carry || !press) return;
        if (!carry.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_SLOP_PX) return;
        if (!rayAt(event.clientX, event.clientY).intersectPlane(floor, onFloor)) return;
        carry.moved = true;
        canvas.style.cursor = "grabbing";
        carry.ghost.visible = true;
        carry.ghost.position.x = onFloor.x + carry.dx;
        carry.ghost.position.z = onFloor.z + carry.dz;
        request();
      },
      { signal: listening.signal },
    );
    const drop = (commit: boolean) => {
      const c = carry;
      if (!c) return false;
      carry = null;
      orbit.enabled = true;
      canvas.style.cursor = "";
      c.ghost.removeFromParent();
      c.ghost.geometry.dispose();
      (c.ghost.material as LineBasicMaterial).dispose();
      request();
      if (commit && c.moved) onMovePiece?.(c.id, c.ghost.position.x, c.ghost.position.z, c.turn);
      return c.moved;
    };
    canvas.addEventListener(
      "pointerup",
      (event) => {
        const start = press;
        press = null;
        if (drop(true)) return;
        if (!start || start.id !== event.pointerId || !room) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        onPick(pickObject(raycaster.ray, room.pickables, lightPickHalf(pixelsPerMetre)));
      },
      { signal: listening.signal },
    );
    canvas.addEventListener(
      "pointercancel",
      () => {
        press = null;
        drop(false);
      },
      { signal: listening.signal },
    );
    // A double-click looks at what it lands on: the room turns about that point and comes closer.
    canvas.addEventListener(
      "dblclick",
      (event) => {
        if (!room) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(room.scene, true)[0];
        if (!hit) return;
        const shift = hit.point.clone().sub(orbit.target);
        moveCamera({
          zoom: Math.min(Math.max(camera.zoom * 1.6, orbit.minZoom), orbit.maxZoom),
          target: hit.point.clone(),
          position: camera.position.clone().add(shift),
        });
      },
      { signal: listening.signal },
    );

    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width === 0 || height === 0 || !room) return;
      renderer.setSize(width, height);
      const aspect = width / height;
      // The room fits the part the dock and the face switch leave free and is centred in it: the
      // frustum grows by both insets and the view slides by half their difference.
      const bottom = Math.min(bottomInset, height * 0.4);
      const top = Math.min(topInset, height * 0.2);
      const inset = bottom + top;
      // Framed on the room as seen from the opening corner, not on its whole bounding sphere: the
      // sphere left more than half the width empty; turning far from that corner may crop a corner.
      const extent = (room.radius * 0.92 * height) / (height - inset);
      camera.left = -extent * aspect;
      camera.right = extent * aspect;
      camera.top = extent;
      camera.bottom = -extent;
      if (inset > 0) camera.setViewOffset(width, height, 0, (bottom - top) / 2, width, height);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      request();
    };
    observer = new ResizeObserver(fit);
    observer.observe(host);

    const show = (config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>) => {
      if (closed) return;
      const first = room === null;
      if (room) disposeScene(room.scene);
      room = buildRoomScene(config, { shadows, lambert: options.lambert ?? false, coldKey: options.coldKey, lampFamilies });
      // Only on opening, or when the room is resized: an edit (a piece carried, a light moved)
      // rebuilds the scene, and taking the target back to the middle threw the view across the room.
      if (first || roomKey(config) !== shownRoom) orbit.target.copy(room.target);
      room.select(selected);
      if (first) {
        const kept = sessionCamera;
        if (kept && kept.room === roomKey(config)) {
          camera.position.copy(kept.position);
          orbit.target.copy(kept.target);
          camera.zoom = kept.zoom;
          camera.updateProjectionMatrix();
        } else {
          placeCamera(room, Math.PI / 4);
        }
        shownRoom = roomKey(config);
      } else if (roomKey(config) !== shownRoom) {
        placeCamera(room, Math.PI / 4);
        shownRoom = roomKey(config);
      }
      renderer.shadowMap.needsUpdate = shadows;
      if (!first) {
        fit();
        return;
      }
      const begin = async (current: RoomScene) => {
        if (options.asyncCompile ?? true) {
          const t0 = performance.now();
          await renderer.compileAsync(current.scene, camera);
          timings.compileMs = performance.now() - t0;
          if (closed) return;
        }
        ready = true;
        fit();
        timings.openMs = performance.now() - started;
      };
      begin(room).catch(onFail);
    };

    window.__roomViewSpikeBench = (n: number) => {
      const current = room;
      if (!current) return { perDrawMs: 0, perDrawFinishedMs: 0 };
      // Timed as a whole: WebKit's clock is coarse, one draw reads as 0 ms.
      const gl = renderer.getContext();
      const run = (sync: boolean) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          placeCamera(current, Math.PI / 4 + (i / n) * Math.PI);
          cut(current);
          renderer.render(current.scene, camera);
          if (sync) gl.finish();
        }
        return (performance.now() - t0) / n;
      };
      const perDrawMs = run(false);
      const perDrawFinishedMs = run(true);
      placeCamera(current, Math.PI / 4);
      request();
      return { perDrawMs, perDrawFinishedMs };
    };

    return {
      camera(kind) {
        if (!room) return;
        if (kind === "reset") {
          const distance = room.radius * 4;
          const azimuth = Math.PI / 4;
          const position = new Vector3(
            room.target.x + distance * Math.sin(POLAR) * Math.sin(azimuth),
            room.target.y + distance * Math.cos(POLAR),
            room.target.z + distance * Math.sin(POLAR) * Math.cos(azimuth),
          );
          moveCamera({ zoom: 1, target: room.target.clone(), position });
          return;
        }
        const factor = kind === "in" ? ZOOM_STEP : 1 / ZOOM_STEP;
        moveCamera({ zoom: Math.min(Math.max(camera.zoom * factor, orbit.minZoom), orbit.maxZoom) });
      },
      setInsets(bottom, top) {
        if (bottom === bottomInset && top === topInset) return;
        bottomInset = bottom;
        topInset = top;
        fit();
      },
      select(objectId) {
        selected = objectId;
        if (room?.select(objectId)) request();
      },
      show(config, lampFamilies) {
        try {
          show(config, lampFamilies);
        } catch (error) {
          onFail(error);
        }
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

const NO_FAMILIES: ReadonlyMap<number, LampFamily> = new Map();

export default function RoomView3D({
  config,
  lampFamilies = NO_FAMILIES,
  label,
  selectedId = null,
  bottomInset = 0,
  topInset = 0,
  cameraCommand,
  onPick,
  onMovePiece,
  onFail,
}: {
  config: RoomMapConfig;
  /** Each Hue channel's fixture, by channel index; absent ones draw as bulbs. */
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  label: string;
  /** The room map's selection, marked in the room. */
  selectedId?: string | null;
  /** Pixels at the view's foot that something floats over; the room is fitted above them. */
  bottomInset?: number;
  /** Pixels at the view's head that something floats over (the View/Edit switch). */
  topInset?: number;
  cameraCommand?: CameraCommand;
  /** A piece carried to a new place on the floor: its centre there, in the scene frame. */
  onMovePiece?: (objectId: string, sceneX: number, sceneZ: number, turnDeg: number) => void;
  /** A click in the room: the object it landed on, or null for empty ground. */
  onPick?: (objectId: string | null) => void;
  /** No view could be drawn — no WebGL context, or the scene failed to build. */
  onFail: (error: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onMoveRef = useRef(onMovePiece);
  onMoveRef.current = onMovePiece;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fail = (error: unknown) => onFailRef.current(error);
    let view: RoomView;
    try {
      view = openRoomView(
        host,
        fail,
        (objectId) => onPickRef.current?.(objectId),
        (objectId, x, z, turn) => onMoveRef.current?.(objectId, x, z, turn),
      );
    } catch (error) {
      fail(error);
      return;
    }
    viewRef.current = view;
    view.select(selectedRef.current);
    return () => {
      viewRef.current = null;
      view.close();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.show(config, lampFamilies);
  }, [config, lampFamilies]);

  useEffect(() => {
    viewRef.current?.setInsets(bottomInset, topInset);
  }, [bottomInset, topInset]);

  useEffect(() => {
    if (cameraCommand) viewRef.current?.camera(cameraCommand.kind);
  }, [cameraCommand]);

  // Its own effect, so a new selection marks the room without building it again.
  useEffect(() => {
    viewRef.current?.select(selectedId);
  }, [selectedId]);

  return <div ref={hostRef} role="img" aria-label={label} className={`absolute inset-0 ${styles.host}`} />;
}
