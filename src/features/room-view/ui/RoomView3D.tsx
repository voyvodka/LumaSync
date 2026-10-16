// Spike: the 3D room, measured in the real app before the room view is built for real. Draws only
// on a change, and hands back everything — context included — on unmount. The rules it follows are
// in docs/architecture/ui-and-shell.md, "Per-window bundles".
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import { type MutableRefObject, useEffect, useRef } from "react";
import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  NeutralToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  Plane,
  PlaneGeometry,
  type Ray,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { FurniturePlacement, RoomMapConfig } from "@/shared/contracts/roomMap";

import { LAMP_COLOURS } from "../model/lampColours";
import type { LampFamily } from "../model/lampFamily";
import { DUSK_AT, MOOD_LEVELS as LEVELS, type RoomMood } from "../model/roomMood";
import { pressStartsCarry } from "../model/carryIntent";
import { lightPickHalf, pickObject } from "../model/picking";
import type { FurnitureModel } from "../model/furnitureModel";
import { pieceNudge } from "../model/pieceNudge";
import { roomToScene } from "../model/roomSpace";
import { planMorph } from "../model/templateMorph";
import { isWindowVisible } from "@/features/shell/windowVisibility";
import { prefersReducedMotion } from "@/shared/lib/motion";

import { buildRoomScene, disposeScene, type RoomScene, type RoomSceneOptions } from "./roomScene";
import { type Bloom, createBloom } from "./scene/bloom";
import { finishMaterial } from "./scene/finishes";
import { furnitureParts } from "./scene/furniture";
import type { LiftedPiece } from "./scene/lift";
import { PALETTE } from "./scene/palette";
import { block, mergeParts } from "./scene/parts";
import { type Morph, startMorph } from "./scene/morph";
import { type Plumb, PLUMB_FROM, plumbGuide } from "./scene/plumb";
import { floorBand } from "./scene/selection";
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

/** A run of edits builds the room once it rests this long: a build is ~90 ms in a furnished room,
 *  and the inspector's X dragged stepped it a few times a frame. */
const SETTLE_MS = 250;
/** A build this soon after the last waits for the run to rest instead. */
const REBUILD_GAP_MS = 200;

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

/** A library card held over the room: its piece where it would land, `model` null for a screen. */
export interface DropGhost {
  piece: FurniturePlacement;
  model: FurnitureModel | null;
  valid: boolean;
}

export interface RoomDropTarget {
  /** The floor under a client point, in the scene frame. */
  floorAt(clientX: number, clientY: number): { x: number; z: number } | null;
  preview(ghost: DropGhost | null): void;
  /** Lets the held card down where it was dropped, then takes it away. */
  settle(): void;
}

interface RoomView extends RoomDropTarget {
  /** `morph`: the room becomes this one piece by piece, as a template does, instead of at once. */
  show(config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>, morph?: boolean): void;
  select(objectId: string | null): void;
  zones(marks: ZoneMarks | null): void;
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
const sameRoom = (a: RoomMapConfig, b: RoomMapConfig) => {
  const keys = Object.keys(a) as (keyof RoomMapConfig)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
/** The frame of a piece being carried: the app's amber. */
const CARRY_COLOUR = 0xffb020;
const REFUSED_COLOUR = 0xff5a4f;
// A held card floats this far off the floor, so it reads as not yet put down.
const DROP_FLOAT_M = 0.12;
// Warm on a held card, red on a refused one, so neither reads as a placed piece.
const DROP_TINT = 0x2a1a00;
const REFUSED_TINT = 0x3a0a08;
const DROP_TINT_INTENSITY = 0.6;
const LAND_MS = 200;
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
  onMovePiece: MovePiece | null,
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
  let zoneMarks: ZoneMarks | null = null;
  let pixelsPerMetre = 0;
  let bottomInset = 0;
  let topInset = 0;
  const listening = new AbortController();
  const closeHooks: (() => void)[] = [];

  const close = () => {
    if (closed) return;
    closed = true;
    closeHooks.forEach((hook) => hook());
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
    let lastCut = 0;
    // Without `now` (a room just built) the walls take their heights at once.
    const cut = (current: RoomScene, now?: number) => {
      direction.subVectors(camera.position, current.target).setY(0).normalize();
      // Idle frames between two moves count as one frame, so a wall starting to move eases from where it stood.
      const dt = now === undefined || prefersReducedMotion() ? Number.POSITIVE_INFINITY : lastCut === 0 ? 1000 / 60 : Math.min(now - lastCut, 1000 / 30);
      if (current.cutWalls(direction, dt) && shadows) renderer.shadowMap.needsUpdate = true;
      lastCut = current.settling() && now !== undefined ? now : 0;
    };

    let ready = false;
    const draw = () => {
      frame = 0;
      if (!room) return;
      const t0 = performance.now();
      // Damping moves the camera a little on every update; keep drawing only while it does.
      const moving = orbit.update();
      cut(room, t0);
      pixelsPerMetre = host.clientHeight / ((camera.top - camera.bottom) / camera.zoom);
      room.setPixelsPerMetre(pixelsPerMetre);
      room.faceCamera(camera.quaternion, camera);
      if (bloom) bloom.render(room.scene, camera);
      else renderer.render(room.scene, camera);
      const now = performance.now();
      if (timings.firstFrameMs === 0) {
        timings.firstFrameAt = now;
        timings.firstFrameMs = now - started;
        host.setAttribute("data-ready", "");
      }
      timings.draws.push(now - t0);
      if (moving || room.settling()) request();
    };
    let away = false;
    const request = () => {
      if (ready && frame === 0 && !closed && !away) frame = requestAnimationFrame(draw);
    };
    let shownRoom = "";
    const views = new Map<string, { position: Vector3; target: Vector3; zoom: number }>();
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
    let steering = false;
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
        steering = true;
        orbit.update();
        steering = false;
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

    // Only a real turn or zoom forgets the way back: `start` also comes with a plain click.
    let home: { zoom: number; target: Vector3; position: Vector3 } | null = null;
    let handling = false;
    orbit.addEventListener("start", () => {
      handling = true;
    });
    orbit.addEventListener("change", () => {
      if (handling && !steering) home = null;
    });
    orbit.addEventListener("end", () => {
      handling = false;
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
    const upright = new Plane(new Vector3(0, 0, 1), 0);
    const onUpright = new Vector3();
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
      rises: boolean;
      fromY: number;
      halfY: number;
      rise: number;
      /** The pointer's height over the piece's centre when ⇧ went down; null while it slides. */
      grip: number | null;
    } | null = null;
    const follow = (c: NonNullable<typeof carry>) => {
      if (!c.lifted) return;
      c.lifted.moveTo(c.ghost.position.x, c.ghost.position.z);
      c.lifted.turnTo((c.turn * Math.PI) / 180);
      if (c.rises) c.lifted.reshape(1, 1, 0, c.rise);
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
        endMorph();
        settleNow();
        if (!room) return;
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
        const rises = item.rises === true;
        const plumb =
          item.kind === "light" && (rises || item.centre.y - hy >= PLUMB_FROM) ? plumbGuide(item.centre.y - hy, CARRY_COLOUR) : null;
        if (plumb) {
          plumb.group.visible = item.centre.y - hy >= PLUMB_FROM;
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
          rises,
          fromY: item.centre.y,
          halfY: hy,
          rise: 0,
          grip: null,
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
        const ray = rayAt(event.clientX, event.clientY);
        if (carry.rises && event.shiftKey) {
          if (!raise(carry, ray)) return;
        } else {
          if (!ray.intersectPlane(floor, onFloor)) return;
          if (carry.grip !== null) {
            carry.grip = null;
            carry.dx = carry.ghost.position.x - onFloor.x;
            carry.dz = carry.ghost.position.z - onFloor.z;
          }
          carry.ghost.position.x = onFloor.x + carry.dx;
          carry.ghost.position.z = onFloor.z + carry.dz;
        }
        if (!carry.tried) lift(carry);
        carry.moved = true;
        canvas.style.cursor = "grabbing";
        carry.ghost.visible = true;
        follow(carry);
        request();
      },
      { signal: listening.signal },
    );
    // Up and down only, along the upright plane through the piece that faces the camera.
    const raise = (c: NonNullable<typeof carry>, ray: Ray) => {
      upright.normal.set(camera.position.x - c.ghost.position.x, 0, camera.position.z - c.ghost.position.z);
      if (upright.normal.lengthSq() < 1e-6) return false;
      upright.normal.normalize();
      upright.constant = -upright.normal.dot(c.ghost.position);
      if (!ray.intersectPlane(upright, onUpright)) return false;
      const centre = c.fromY + c.rise;
      if (c.grip === null) c.grip = onUpright.y - centre;
      const ceiling = shownConfig?.dimensions.heightMeters ?? Number.POSITIVE_INFINITY;
      // A ceiling light's lit part is built at the ceiling, whatever its height says.
      const y = Math.min(Math.max(onUpright.y - c.grip, Math.min(c.halfY, c.fromY)), Math.max(ceiling - c.halfY, c.fromY));
      c.rise = y - c.fromY;
      c.ghost.position.y = Math.max(y, 0.025);
      floor.constant = -y;
      if (c.plumb) {
        c.plumb.group.position.y = -c.ghost.position.y;
        c.plumb.setTop(y - c.halfY);
        c.plumb.group.visible = true;
      }
      return true;
    };
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
      const raised = c.rise !== 0 ? { rise: c.rise, centreY: c.fromY + c.rise } : undefined;
      const landed = commit && c.moved && onMovePiece?.(c.id, c.ghost.position.x, c.ghost.position.z, c.turn, c.lifted?.riders ?? [], raised) === true;
      // Still lifted where it was let go: the landed room must be built, not read as a slide of it.
      if (landed && c.lifted) builtConfig = null;
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
    let builtConfig: RoomMapConfig | null = null;
    let builtAt = 0;
    // A piece slid in place while the room it was built in waits to be built again.
    let nudged: { id: string; lifted: LiftedPiece; dx: number; dz: number } | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let morphNext = false;
    const holding = new Scene();
    let morph: Morph | null = null;
    let morphFrame = 0;
    const endMorph = () => {
      cancelAnimationFrame(morphFrame);
      morphFrame = 0;
      morph?.finish();
      morph = null;
    };
    closeHooks.push(endMorph);
    // Out of the scene before it is disposed: a held card's buffers outlive the room it floats in.
    let detachDrop = () => {};
    const settleLater = () => {
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        buildShown();
      }, SETTLE_MS);
    };
    closeHooks.push(() => {
      if (settle !== null) clearTimeout(settle);
    });
    // Before a carry lifts from the scene: lifting a slid piece again would copy its emptied spans.
    const settleNow = () => {
      if (settle === null) return;
      clearTimeout(settle);
      settle = null;
      buildShown();
    };
    // Off `show`'s own guard, so a failed deferred build is reported as an immediate one is.
    const buildShown = () => {
      try {
        if (shownConfig && shownFamilies) build(shownConfig, shownFamilies);
      } catch (error) {
        onFail(error);
      }
    };
    const show = (config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>, morphing = false) => {
      if (closed) return;
      // Adopted across a face switch, or an applied preview's copy: rebuilding would cut its morph short.
      if (shownConfig && sameRoom(config, shownConfig) && lampFamilies === shownFamilies) return;
      const sameFamilies = lampFamilies === shownFamilies;
      shownConfig = config;
      shownFamilies = lampFamilies;
      if (morphing) morphNext = true;
      if (room && builtConfig && sameFamilies && !carry && !morphNext) {
        const nudge = pieceNudge(builtConfig, config);
        // A gliding piece is already lifted out; lifting it again would copy its emptied spans.
        if (nudge) endMorph();
        const lifted = nudge ? (nudged?.id === nudge.objectId ? nudged.lifted : room.lift(nudge.objectId, false)) : null;
        if (nudge && lifted) {
          nudged = { id: nudge.objectId, lifted, dx: nudge.dx, dz: nudge.dy };
          lifted.moveTo(lifted.pivot.x + nudge.dx, lifted.pivot.z + nudge.dy);
          const shape = nudge.reshape;
          lifted.reshape(shape?.scaleX ?? 1, shape?.scaleY ?? 1, shape?.aboutY ?? 0, shape?.raise ?? 0);
          if (selected === nudge.objectId) room.shiftMark(nudge.dx, nudge.dy);
          renderer.shadowMap.needsUpdate = shadows;
          request();
          settleLater();
          return;
        }
        if (performance.now() - builtAt < REBUILD_GAP_MS) {
          settleLater();
          return;
        }
      }
      build(config, lampFamilies);
    };
    const build = (config: RoomMapConfig, lampFamilies: ReadonlyMap<number, LampFamily>) => {
      if (settle !== null) clearTimeout(settle);
      settle = null;
      const slid = nudged;
      nudged = null;
      endMorph();
      const was = builtConfig;
      const plan = morphNext && room && was && !prefersReducedMotion() ? planMorph(was, config) : null;
      morphNext = false;
      builtConfig = config;
      // Rebuilt by another writer mid-carry: put the piece down first, while its buffers still exist.
      if (carry) {
        press = null;
        drop(false);
      }
      const first = room === null;
      const leaving: LiftedPiece[] = [];
      if (room) {
        detachDrop();
        if (plan) {
          for (const piece of plan.leaving) {
            const lifted = slid?.id === piece.objectId ? slid.lifted : room.lift(piece.objectId, false);
            if (!lifted) continue;
            // Lifted copies are the old scene's children; disposing it would empty them.
            lifted.rehome(holding);
            leaving.push(lifted);
          }
        }
        disposeScene(room.scene);
      }
      room = buildRoomScene(config, { shadows, lambert: options.lambert ?? false, coldKey: options.coldKey, lampFamilies });
      // Only on opening, or when the room is resized: an edit (a piece carried, a light moved)
      // rebuilds the scene, and taking the target back to the middle threw the view across the room.
      if (first || roomKey(config) !== shownRoom) orbit.target.copy(room.target);
      room.select(selected);
      room.markZones(zoneMarks);
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
        // Kept from before any dolly to a light, or each return from a template would zoom in further.
        if (move !== 0) cancelAnimationFrame(move);
        move = 0;
        views.set(shownRoom, home ?? { position: camera.position.clone(), target: orbit.target.clone(), zoom: camera.zoom });
        home = null;
        const back = views.get(roomKey(config));
        if (back) {
          camera.position.copy(back.position);
          orbit.target.copy(back.target);
          camera.zoom = back.zoom;
          camera.updateProjectionMatrix();
        } else {
          placeCamera(room, Math.PI / 4);
        }
        shownRoom = roomKey(config);
      }
      // A new scene's walls stand where the camera already cuts them, rather than easing down on its first frame.
      cut(room);
      if (plan) {
        const current = room;
        for (const lifted of leaving) lifted.rehome(current.scene);
        morph = startMorph(plan, (objectId) => current.lift(objectId, false), leaving, performance.now());
        const step = () => {
          if (!morph || closed) return;
          const running = morph.step(performance.now());
          renderer.shadowMap.needsUpdate = shadows;
          request();
          morphFrame = running ? requestAnimationFrame(step) : 0;
          if (!running) morph = null;
        };
        morphFrame = requestAnimationFrame(step);
      }
      renderer.shadowMap.needsUpdate = shadows;
      builtAt = performance.now();
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

    // A held library card: built once per card, then only moved.
    let dropGhost: { key: string; group: Group; mesh: Mesh | null } | null = null;
    let settleFrame = 0;
    const dropMaterial = finishMaterial("matte", { lambert: options.lambert ?? false }) as MeshStandardMaterial;
    dropMaterial.emissiveIntensity = DROP_TINT_INTENSITY;
    // WebGL draws every line 1 px wide, so the footprint is the selection's band, filled faintly.
    const bandMaterial = new MeshBasicMaterial({
      color: CARRY_COLOUR,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const fillMaterial = bandMaterial.clone();
    fillMaterial.opacity = 0.2;
    const dropFloor = new Plane(new Vector3(0, 1, 0), 0);
    detachDrop = () => dropGhost?.group.removeFromParent();
    const clearDrop = () => {
      cancelAnimationFrame(settleFrame);
      settleFrame = 0;
      if (!dropGhost) return;
      dropGhost.group.removeFromParent();
      dropGhost.group.traverse((node) => {
        if (node instanceof Mesh) node.geometry.dispose();
      });
      dropGhost = null;
    };
    closeHooks.push(() => {
      clearDrop();
      dropMaterial.dispose();
      bandMaterial.dispose();
      fillMaterial.dispose();
    });
    const previewDrop = (ghost: DropGhost | null) => {
      if (!room || !shownConfig || !ghost) {
        if (dropGhost) {
          clearDrop();
          renderer.shadowMap.needsUpdate = shadows;
          request();
        }
        return;
      }
      if (settleFrame) clearDrop();
      const { piece, model } = ghost;
      const dims = shownConfig.dimensions;
      const key = `${model ? piece.type : "screen"}:${piece.width}:${piece.height}`;
      if (dropGhost?.key !== key || dropGhost.group.parent !== room.scene) {
        clearDrop();
        const tall = piece.width * 0.5625;
        const parts = model
          ? furnitureParts({ ...piece, x: 0, y: 0 }, model)
          : [block(piece.width, tall, 0.04, 0, dims.heightMeters * 0.4 - tall / 2, 0, PALETTE.bezel, 0.005)];
        const group = new Group();
        const mesh = mergeParts(parts, dropMaterial);
        if (mesh) {
          mesh.castShadow = true;
          mesh.position.y = DROP_FLOAT_M;
          group.add(mesh);
        }
        for (const floor of [new Mesh(floorBand(piece.width, piece.height), bandMaterial), new Mesh(new PlaneGeometry(piece.width, piece.height), fillMaterial)]) {
          floor.rotation.x = -Math.PI / 2;
          floor.position.y = 0.006;
          group.add(floor);
        }
        room.scene.add(group);
        dropGhost = { key, group, mesh };
      }
      const centre = roomToScene(piece.x + piece.width / 2, piece.y + piece.height / 2, 0, dims);
      dropGhost.group.position.set(centre.x, 0, centre.z);
      const colour = ghost.valid ? CARRY_COLOUR : REFUSED_COLOUR;
      bandMaterial.color.setHex(colour);
      fillMaterial.color.setHex(colour);
      dropMaterial.emissive.setHex(ghost.valid ? DROP_TINT : REFUSED_TINT);
      dropMaterial.emissiveIntensity = DROP_TINT_INTENSITY;
      renderer.shadowMap.needsUpdate = shadows;
      request();
    };
    const settleDrop = () => {
      const held = dropGhost;
      if (!held || settleFrame || !held.mesh || prefersReducedMotion()) {
        previewDrop(null);
        return;
      }
      const mesh = held.mesh;
      const start = performance.now();
      const step = () => {
        const t = Math.min((performance.now() - start) / LAND_MS, 1);
        if (t >= 1 || closed || dropGhost !== held || !room) {
          settleFrame = 0;
          if (dropGhost === held) previewDrop(null);
          return;
        }
        // A rebuild for the new piece swaps the scene: the ghost follows it.
        if (held.group.parent !== room.scene) room.scene.add(held.group);
        const k = easeOut(t);
        mesh.position.y = DROP_FLOAT_M * (1 - k);
        dropMaterial.emissiveIntensity = DROP_TINT_INTENSITY * (1 - k);
        renderer.shadowMap.needsUpdate = shadows;
        request();
        settleFrame = requestAnimationFrame(step);
      };
      settleFrame = requestAnimationFrame(step);
    };

    return {
      floorAt(clientX, clientY) {
        if (!room) return null;
        const hit = rayAt(clientX, clientY).intersectPlane(dropFloor, new Vector3());
        return hit ? { x: hit.x, z: hit.z } : null;
      },
      preview: previewDrop,
      settle: settleDrop,
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
        const mine = nudged && nudged.id === objectId ? nudged : null;
        room?.shiftMark(mine?.dx ?? 0, mine?.dz ?? 0);
        if (room?.select(objectId) || nudged) request();
        if (ready) focusOn(objectId, previous);
      },
      zones(marks) {
        zoneMarks = marks;
        if (room?.markZones(marks)) request();
      },
      show(config, lampFamilies, morphing) {
        try {
          show(config, lampFamilies, morphing);
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

/** `raised`: ⇧ took the piece up or down by `rise` metres, its centre then `centreY` high. */
export type MovePiece = (
  objectId: string,
  sceneX: number,
  sceneZ: number,
  turnDeg: number,
  riders: readonly string[],
  raised?: { rise: number; centreY: number },
) => boolean;

interface Handlers {
  fail: (error: unknown) => void;
  pick: (objectId: string | null) => void;
  move: MovePiece;
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
  zones = null,
  bottomInset = 0,
  topInset = 0,
  cameraCommand,
  mood,
  onPick,
  onHover,
  onMovePiece,
  onFail,
  dropRef,
  morphKey,
}: {
  config: RoomMapConfig;
  /** Each Hue channel's fixture, by channel index; absent ones draw as bulbs. */
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  label: string;
  /** The room map's selection, marked in the room. */
  selectedId?: string | null;
  zones?: ZoneMarks | null;
  /** Pixels at the view's foot that something floats over; the room is fitted above them. */
  bottomInset?: number;
  /** Pixels at the view's head that something floats over (the View/Edit switch). */
  topInset?: number;
  cameraCommand?: CameraCommand;
  mood?: RoomMood;
  /** A piece carried to a new place on the floor: its centre there, in the scene frame. */
  onMovePiece?: MovePiece;
  /** A click in the room: the object it landed on, or null for empty ground. */
  onPick?: (objectId: string | null) => void;
  onHover?: (objectId: string | null, clientX: number, clientY: number) => void;
  /** No view could be drawn — no WebGL context, or the scene failed to build. */
  onFail: (error: unknown) => void;
  /** Filled while the view is open, for a library card dragged in from the dock. */
  dropRef?: MutableRefObject<RoomDropTarget | null>;
  /** Changed with a room it should become piece by piece, as a template does. */
  morphKey?: number;
}) {
  const shownMorph = useRef(morphKey);
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
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mine: Handlers = {
      fail: (error) => onFailRef.current(error),
      pick: (objectId) => onPickRef.current?.(objectId),
      move: (objectId, x, z, turn, riders, raised) => onMoveRef.current?.(objectId, x, z, turn, riders, raised) ?? false,
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
          (objectId, x, z, turn, riders, raised) => handlers.move(objectId, x, z, turn, riders, raised),
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
    view.zones(zonesRef.current);
    if (moodRef.current) view.setMood(moodRef.current);
    return () => {
      viewRef.current = null;
      view.preview(null);
      park(view, handlers);
    };
  }, []);

  // After the opening effect, so the view it hands out is the one just opened.
  useEffect(() => {
    const view = viewRef.current;
    if (!dropRef || !view) return;
    dropRef.current = view;
    return () => {
      if (dropRef.current === view) dropRef.current = null;
    };
  }, [dropRef]);

  useEffect(() => {
    const morphing = morphKey !== shownMorph.current;
    shownMorph.current = morphKey;
    viewRef.current?.show(config, lampFamilies, morphing);
  }, [config, lampFamilies, morphKey]);

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

  useEffect(() => {
    viewRef.current?.zones(zones);
  }, [zones]);

  return <div ref={hostRef} role="img" aria-label={label} className={`absolute inset-0 ${styles.host}`} />;
}
