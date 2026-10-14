// Spike: the 3D room, measured in the real app before the room view is built for real. Draws only
// on a change, and hands back everything — context included — on unmount. The rules it follows are
// in docs/architecture/ui-and-shell.md, "Per-window bundles".
import { useEffect, useRef } from "react";
import { NeutralToneMapping, OrthographicCamera, PCFShadowMap, SRGBColorSpace, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import type { LampFamily } from "../model/lampFamily";
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
  close(): void;
}

const POLAR = 0.95;

/** The renderer, camera and controls live as long as the view; a room-map change swaps only the
 *  scene. Throws when no WebGL context can be had. */
function openRoomView(host: HTMLElement, onFail: (error: unknown) => void): RoomView {
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

  const close = () => {
    if (closed) return;
    closed = true;
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
    orbit.enablePan = false;
    orbit.zoomToCursor = true;
    orbit.minZoom = 0.8;
    orbit.maxZoom = 3;
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
      room.setPixelsPerMetre(host.clientHeight / ((camera.top - camera.bottom) / camera.zoom));
      renderer.render(room.scene, camera);
      const now = performance.now();
      if (timings.firstFrameMs === 0) {
        timings.firstFrameAt = now;
        timings.firstFrameMs = now - started;
      }
      timings.draws.push(now - t0);
      if (moving) request();
    };
    const request = () => {
      if (ready && frame === 0 && !closed) frame = requestAnimationFrame(draw);
    };
    orbit.addEventListener("change", request);

    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width === 0 || height === 0 || !room) return;
      renderer.setSize(width, height);
      const aspect = width / height;
      const extent = room.radius * 1.15;
      camera.left = -extent * aspect;
      camera.right = extent * aspect;
      camera.top = extent;
      camera.bottom = -extent;
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
      orbit.target.copy(room.target);
      if (first) placeCamera(room, Math.PI / 4);
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
  onFail,
}: {
  config: RoomMapConfig;
  /** Each Hue channel's fixture, by channel index; absent ones draw as bulbs. */
  lampFamilies?: ReadonlyMap<number, LampFamily>;
  label: string;
  /** No view could be drawn — no WebGL context, or the scene failed to build. */
  onFail: (error: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fail = (error: unknown) => onFailRef.current(error);
    let view: RoomView;
    try {
      view = openRoomView(host, fail);
    } catch (error) {
      fail(error);
      return;
    }
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.close();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.show(config, lampFamilies);
  }, [config, lampFamilies]);

  return <div ref={hostRef} role="img" aria-label={label} className={`absolute inset-0 ${styles.host}`} />;
}
