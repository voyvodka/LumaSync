// Spike: the 3D room, measured in the real app before the room view is built for real. Draws only
// on a change, and hands back everything — context included — on unmount. The rules it follows are
// in docs/architecture/ui-and-shell.md, "Per-window bundles".
import { useEffect, useRef } from "react";
import {
  BoxGeometry,
  Color,
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

import { LAMP_COLOURS } from "../model/lampColours";
import type { LampFamily } from "../model/lampFamily";
import { DUSK_AT, MOOD_LEVELS as LEVELS, type RoomMood } from "../model/roomMood";
import { pressStartsCarry } from "../model/carryIntent";
import { lightPickHalf, pickObject } from "../model/picking";
import { isWindowVisible } from "@/features/shell/windowVisibility";
import { prefersReducedMotion } from "@/shared/lib/motion";

import { buildRoomScene, disposeScene, type RoomScene, type RoomSceneOptions } from "./roomScene";
import { type Bloom, createBloom } from "./scene/bloom";
import type { LiftedPiece } from "./scene/lift";
import { type Plumb, PLUMB_FROM, plumbGuide } from "./scene/plumb";
import styles from "./RoomView3D.module.css";

/** What a measuring run varies; absent fields take the defaults below. */
interface SpikeOptions extends Partial<RoomSceneOptions> {
  antialias?: boolean;
  pixelRatio?: number;
  /** Compile every program off the first frame's path with `compileAsync` (default on). */
  asyncCompile?: boolean;
  /** Shrink the canvas to 1×1 after the context is lost, so WebKit drops its buffers at once. */
  shrinkOnClose?: boolean;
  bloom?: boolean;
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
  setMood(mood: RoomMood): void;
  /** Whether its programs are compiled; one that is not yet is closed rather than parked. */
  ready(): boolean;
  /** Takes the canvas off the page and stops drawing, keeping the context and the scene. */
  park(): void;
  adopt(host: HTMLElement): void;
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
const MOOD_MS = 900;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const DOLLY_MS = 760;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const DOLLY_ZOOM = 1.55;
/** Short of the light itself, so it is framed in its corner with the room around it. */
const DOLLY_REACH = 0.7;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const POLAR = 0.8;
/** A press that moves further than this turns the room; one that stays within it is a click (the
 *  plan's rule, `CLICK_SLOP_PX` in snapGeometry.ts, so a nudge while clicking a lamp does not throw
 *  the selection away). */
const CLICK_SLOP_PX = 6;

/** The renderer, camera and controls live as long as the view; a room-map change swaps only the
 *  scene. Throws when no WebGL context can be had. */
function openRoomView(
  firstHost: HTMLElement,
  onFail: (error: unknown) => void,
  onPick: (objectId: string | null) => void,
  onMovePiece: ((objectId: string, sceneX: number, sceneZ: number, turnDeg: number, riders: readonly string[]) => boolean) | null,
  onHover: (objectId: string | null, clientX: number, clientY: number) => void = () => {},
): RoomView {
  let host = firstHost;
  const options: SpikeOptions = window.__roomViewSpikeOptions ?? {};
  const started = performance.now();
  const timings: Timings = { options, openMs: 0, compileMs: 0, firstFrameMs: 0, firstFrameAt: 0, draws: [] };
  window.__roomViewSpike = timings;

  // Measured: MSAA added ~50 MB to the page process at 2×, where the pixel density already
  // smooths the edges, so it is on only for a 1× screen.
  const pixelRatio = Math.min(window.devicePixelRatio, options.pixelRatio ?? 2);
  // Transparent, so the view's night backdrop (a CSS gradient) shows behind the room.
  const antialias = options.antialias ?? pixelRatio < 2;
  const renderer = new WebGLRenderer({ antialias, alpha: true });
  let bloom: Bloom | null = null;
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
    bloom?.dispose();
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
    if (options.bloom ?? true) bloom = createBloom(renderer, antialias);
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
      if (bloom) bloom.render(room.scene, camera);
      else renderer.render(room.scene, camera);
      const now = performance.now();
      if (timings.firstFrameMs === 0) {
        timings.firstFrameAt = now;
        timings.firstFrameMs = now - started;
        host.setAttribute("data-ready", "");
      }
      timings.draws.push(now - t0);
      if (moving) request();
    };
    let away = false;
    const request = () => {
      if (ready && frame === 0 && !closed && !away) frame = requestAnimationFrame(draw);
    };
    let shownRoom = "";
    const moodNow = { colour: new Color(LAMP_COLOURS[0]), level: 1, ambient: 1, strip: 1, daylight: DUSK_AT };
    let moodFrame = 0;
    let moodTarget: RoomMood | null = null;
    const paintMood = () => room?.setMood(moodNow.colour.getHex(), moodNow, moodTarget?.palette);
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
    const moveCamera = (to: { zoom: number; target?: Vector3; position?: Vector3 }, ms = CAMERA_MOVE_MS, ease = easeOut) => {
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
        const t = Math.min((now - start) / ms, 1);
        apply(ease(t));
        move = t < 1 && !closed ? requestAnimationFrame(step) : 0;
      };
      move = requestAnimationFrame(step);
    };

    // Turning or zooming by hand while a light is picked forgets the way back: the user's view wins.
    let home: { zoom: number; target: Vector3; position: Vector3 } | null = null;
    orbit.addEventListener("start", () => {
      home = null;
    });
    const focusOn = (objectId: string | null, previous: string | null) => {
      if (!room || objectId === previous) return;
      const item = objectId ? room.pickables.find((p) => p.id === objectId && (p.kind === "light" || p.kind === "tv")) : undefined;
      if (!item) {
        if (home) moveCamera(home, DOLLY_MS, easeOutExpo);
        home = null;
        return;
      }
      if (!home) home = { zoom: camera.zoom, target: orbit.target.clone(), position: camera.position.clone() };
      const target = new Vector3(item.centre.x, Math.min(item.centre.y, room.target.y * 2) * 0.6, item.centre.z).lerp(
        room.target,
        1 - DOLLY_REACH,
      );
      const position = camera.position.clone().add(target.clone().sub(orbit.target));
      const zoom = Math.min(Math.max(home.zoom * DOLLY_ZOOM, camera.zoom), orbit.maxZoom);
      moveCamera({ zoom, target, position }, DOLLY_MS, easeOutExpo);
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
    // Only the selected object is carried, at its own height; a press on anything else turns the room.
    let carry: {
      id: string;
      kind: string;
      dx: number;
      dz: number;
      ghost: LineSegments;
      /** A high light's line to the floor, riding in the ghost. */
      plumb: Plumb | null;
      lifted: LiftedPiece | null;
      /** Lifted on the first move or turn, whether or not it could be. */
      tried: boolean;
      moved: boolean;
      turn: number;
      angle: number;
    } | null = null;
    const follow = (c: NonNullable<typeof carry>) => {
      if (!c.lifted) return;
      c.lifted.moveTo(c.ghost.position.x, c.ghost.position.z);
      c.lifted.turnTo((c.turn * Math.PI) / 180);
      renderer.shadowMap.needsUpdate = shadows;
    };
    // While a piece of furniture is carried, the wheel or R turns it in 15° steps (⇧ the other way);
    // the TV and the lights keep the axes they have.
    const turnCarry = (by: number) => {
      if (!carry || carry.kind !== "furniture") return;
      if (!carry.tried) lift(carry);
      carry.turn = (((carry.turn + by) % 360) + 360) % 360;
      carry.moved = true;
      carry.ghost.visible = true;
      carry.ghost.rotation.y = -(carry.angle + (carry.turn * Math.PI) / 180);
      follow(carry);
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
        onHover(null, 0, 0);
        if (!press || !room || !onMovePiece) return;
        const ray = rayAt(event.clientX, event.clientY);
        // The selected one is carried when the press lands on it, even behind something nearer:
        // the TV's backlight strip covers the TV and took every press on it.
        const mine = room.pickables.find((p) => p.id === selected);
        const item = mine && pickObject(ray, [mine], lightPickHalf(pixelsPerMetre)) === mine.id ? mine : undefined;
        const id = item?.id;
        if (!id || !item || !pressStartsCarry(item, selected)) return;
        // Dragged across the level it stands at, so a pendant follows the pointer, not the floor below it.
        floor.constant = -item.centre.y;
        if (!ray.intersectPlane(floor, onFloor)) return;
        const [hx, hy, hz] = item.half;
        const ghost = new LineSegments(
          new EdgesGeometry(new BoxGeometry(hx * 2, Math.max(hy * 2, 0.05), hz * 2)),
          new LineBasicMaterial({ color: CARRY_COLOUR }),
        );
        ghost.position.set(item.centre.x, Math.max(item.centre.y, 0.025), item.centre.z);
        ghost.rotation.y = -item.angle;
        ghost.visible = false;
        const plumb = item.kind === "light" && item.centre.y - hy >= PLUMB_FROM ? plumbGuide(item.centre.y - hy, CARRY_COLOUR) : null;
        if (plumb) {
          plumb.group.position.y = -ghost.position.y;
          ghost.add(plumb.group);
        }
        room.scene.add(ghost);
        carry = {
          id,
          kind: item.kind,
          dx: item.centre.x - onFloor.x,
          dz: item.centre.z - onFloor.z,
          ghost,
          plumb,
          lifted: null,
          tried: false,
          moved: false,
          turn: 0,
          angle: item.angle,
        };
        orbit.enabled = false;
        canvas.setPointerCapture(event.pointerId);
      },
      { signal: listening.signal },
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!carry && !press && room) {
          const ray = rayAt(event.clientX, event.clientY);
          const lit = room.pickables.filter((p) => p.kind === "light" || p.kind === "tv");
          onHover(pickObject(ray, lit, lightPickHalf(pixelsPerMetre)), event.clientX, event.clientY);
          if (!onMovePiece) return;
          // The selected piece says it can be picked up; nothing else changes the cursor.
          const mine = room.pickables.find((p) => p.id === selected);
          const over = mine !== undefined && pickObject(ray, [mine], lightPickHalf(pixelsPerMetre)) === mine.id;
          canvas.style.cursor = over && pressStartsCarry(mine, selected) ? "grab" : "";
          return;
        }
        if (!carry || !press) return;
        if (!carry.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_SLOP_PX) return;
        if (!rayAt(event.clientX, event.clientY).intersectPlane(floor, onFloor)) return;
        if (!carry.tried) lift(carry);
        carry.moved = true;
        canvas.style.cursor = "grabbing";
        carry.ghost.visible = true;
        carry.ghost.position.x = onFloor.x + carry.dx;
        carry.ghost.position.z = onFloor.z + carry.dz;
        follow(carry);
        request();
      },
      { signal: listening.signal },
    );
    // Lifted on the first move, not the press: a click on the selected piece leaves the scene as built.
    const lift = (c: NonNullable<typeof carry>) => {
      c.tried = true;
      if (!room) return;
      c.lifted = room.lift(c.id);
      // The mark stays where the piece was built; the frame marks it while it is carried.
      if (c.lifted) room.select(null);
    };
    const drop = (commit: boolean) => {
      const c = carry;
      if (!c) return false;
      carry = null;
      orbit.enabled = true;
      canvas.style.cursor = "";
      c.ghost.removeFromParent();
      c.plumb?.dispose();
      c.ghost.geometry.dispose();
      (c.ghost.material as LineBasicMaterial).dispose();
      // Landed, it stays where it was let go until the scene is rebuilt from the landed room; a
      // landing refused, or Esc, puts it back.
      const landed = commit && c.moved && onMovePiece?.(c.id, c.ghost.position.x, c.ghost.position.z, c.turn, c.lifted?.riders ?? []) === true;
      if (c.lifted && !landed) {
        c.lifted.restore();
        room?.select(selected);
        renderer.shadowMap.needsUpdate = shadows;
      }
      request();
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
    canvas.addEventListener("pointerleave", () => onHover(null, 0, 0), { signal: listening.signal });
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
      bloom?.setSize(width, height);
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

    let shownConfig: RoomMapConfig | null = null;
    let shownFamilies: ReadonlyMap<number, LampFamily> | null = null;
    const show = (config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>) => {
      if (closed) return;
      // A view adopted across a face switch is handed the room it already shows.
      if (config === shownConfig && lampFamilies === shownFamilies) return;
      shownConfig = config;
      shownFamilies = lampFamilies;
      // Rebuilt by another writer mid-carry: put the piece down first, while its buffers still exist.
      if (carry) {
        press = null;
        drop(false);
      }
      const first = room === null;
      if (room) disposeScene(room.scene);
      room = buildRoomScene(config, { shadows, lambert: options.lambert ?? false, coldKey: options.coldKey, lampFamilies });
      // Only on opening, or when the room is resized: an edit (a piece carried, a light moved)
      // rebuilds the scene, and taking the target back to the middle threw the view across the room.
      if (first || roomKey(config) !== shownRoom) orbit.target.copy(room.target);
      room.select(selected);
      paintMood();
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
          if (bloom) bloom.render(current.scene, camera);
          else renderer.render(current.scene, camera);
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
      setMood(mood) {
        const same = (m: RoomMood | null) =>
          m !== null &&
          LEVELS.every((key) => m[key] === mood[key]) &&
          m.lamp === mood.lamp &&
          (m.palette ?? []).join() === (mood.palette ?? []).join();
        if (same(moodTarget)) return;
        moodTarget = mood;
        if (moodFrame !== 0) cancelAnimationFrame(moodFrame);
        moodFrame = 0;
        const colour0 = moodNow.colour.clone();
        const from = { ...moodNow };
        const colour1 = new Color(mood.lamp);
        if (colour0.equals(colour1) && LEVELS.every((key) => from[key] === mood[key])) {
          paintMood();
          request();
          return;
        }
        const end = () => {
          moodNow.colour.copy(colour1);
          for (const key of LEVELS) moodNow[key] = mood[key];
          paintMood();
          request();
        };
        if (!ready || prefersReducedMotion()) {
          end();
          return;
        }
        const start = performance.now();
        const step = () => {
          const t = Math.min((performance.now() - start) / MOOD_MS, 1);
          if (t >= 1 || closed) {
            moodFrame = 0;
            if (!closed) end();
            return;
          }
          const k = easeInOut(t);
          moodNow.colour.lerpColors(colour0, colour1, k);
          for (const key of LEVELS) moodNow[key] = from[key] + (mood[key] - from[key]) * k;
          paintMood();
          request();
          moodFrame = requestAnimationFrame(step);
        };
        moodFrame = requestAnimationFrame(step);
      },
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
        const previous = selected;
        selected = objectId;
        if (room?.select(objectId)) request();
        if (ready) focusOn(objectId, previous);
      },
      show(config, lampFamilies) {
        try {
          show(config, lampFamilies);
        } catch (error) {
          onFail(error);
        }
      },
      ready: () => ready,
      park() {
        away = true;
        press = null;
        drop(false);
        onHover(null, 0, 0);
        observer?.disconnect();
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        renderer.domElement.remove();
      },
      adopt(next) {
        away = false;
        host = next;
        host.appendChild(renderer.domElement);
        if (ready) host.setAttribute("data-ready", "");
        observer?.disconnect();
        observer = new ResizeObserver(fit);
        observer.observe(host);
        fit();
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

const NO_FAMILIES: ReadonlyMap<number, LampFamily> = new Map();

interface Handlers {
  fail: (error: unknown) => void;
  pick: (objectId: string | null) => void;
  move: (objectId: string, sceneX: number, sceneZ: number, turnDeg: number, riders: readonly string[]) => boolean;
  hover: (objectId: string | null, clientX: number, clientY: number) => void;
}
const IDLE: Handlers = { fail: () => {}, pick: () => {}, move: () => false, hover: () => {} };
/** A new context, its shaders and the scene paused every face or stage switch; one is kept this long. */
const PARK_MS = 20_000;
let parked: { view: RoomView; handlers: Handlers; timer: ReturnType<typeof setTimeout> } | null = null;

function park(view: RoomView, handlers: Handlers) {
  view.park();
  Object.assign(handlers, IDLE);
  if (parked) {
    clearTimeout(parked.timer);
    parked.view.close();
  }
  if (!isWindowVisible() || !view.ready()) {
    parked = null;
    view.close();
    return;
  }
  const timer = setTimeout(() => {
    if (parked?.view === view) parked = null;
    view.close();
  }, PARK_MS);
  parked = { view, handlers, timer };
}

export function __closeParkedRoomViewForTests(): void {
  if (!parked) return;
  clearTimeout(parked.timer);
  parked.view.close();
  parked = null;
}

function unpark(host: HTMLElement, handlers: Handlers): { view: RoomView; handlers: Handlers } | null {
  const kept = parked;
  if (!kept) return null;
  parked = null;
  clearTimeout(kept.timer);
  Object.assign(kept.handlers, handlers);
  kept.view.adopt(host);
  return kept;
}

export default function RoomView3D({
  config,
  lampFamilies = NO_FAMILIES,
  label,
  selectedId = null,
  bottomInset = 0,
  topInset = 0,
  cameraCommand,
  mood,
  onPick,
  onHover,
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
  mood?: RoomMood;
  /** A piece carried to a new place on the floor: its centre there, in the scene frame. */
  onMovePiece?: (objectId: string, sceneX: number, sceneZ: number, turnDeg: number, riders: readonly string[]) => boolean;
  /** A click in the room: the object it landed on, or null for empty ground. */
  onPick?: (objectId: string | null) => void;
  onHover?: (objectId: string | null, clientX: number, clientY: number) => void;
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
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mine: Handlers = {
      fail: (error) => onFailRef.current(error),
      pick: (objectId) => onPickRef.current?.(objectId),
      move: (objectId, x, z, turn, riders) => onMoveRef.current?.(objectId, x, z, turn, riders) ?? false,
      hover: (objectId, x, y) => onHoverRef.current?.(objectId, x, y),
    };
    let kept = unpark(host, mine);
    if (!kept) {
      const handlers = { ...mine };
      try {
        const view = openRoomView(
          host,
          (error) => handlers.fail(error),
          (objectId) => handlers.pick(objectId),
          (objectId, x, z, turn, riders) => handlers.move(objectId, x, z, turn, riders),
          (objectId, x, y) => handlers.hover(objectId, x, y),
        );
        kept = { view, handlers };
      } catch (error) {
        mine.fail(error);
        return;
      }
    }
    const { view, handlers } = kept;
    viewRef.current = view;
    view.select(selectedRef.current);
    if (moodRef.current) view.setMood(moodRef.current);
    return () => {
      viewRef.current = null;
      park(view, handlers);
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

  useEffect(() => {
    if (mood) viewRef.current?.setMood(mood);
  }, [mood]);

  // Its own effect, so a new selection marks the room without building it again.
  useEffect(() => {
    viewRef.current?.select(selectedId);
  }, [selectedId]);

  return <div ref={hostRef} role="img" aria-label={label} className={`absolute inset-0 ${styles.host}`} />;
}
