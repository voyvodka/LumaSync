// SceneApp — root of the `led-preview-scene` window: the test scene the
// session names, full screen under the twin and the popup, for Ambilight to
// capture. Black until the session names a scene, which it does only once the
// capture can see this window.

import { useEffect, useRef } from "react";

import type { SceneKind } from "@/shared/contracts/preview";
import { SCENE_RENDERERS } from "../scenes";
import { usePreviewSession } from "../state/usePreviewSession";
import styles from "./SceneApp.module.css";

export function SceneApp() {
  const session = usePreviewSession();
  const scene: SceneKind | null = session?.state === "scene" ? session.scene : null;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // CSS pixels, not device pixels: the capture samples a downscaled frame,
    // and a scene is smooth colour that gains nothing from more of them.
    const fit = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    fit();
    window.addEventListener("resize", fit);
    if (scene === null) {
      ctx.fillStyle = "rgb(0 0 0)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return () => window.removeEventListener("resize", fit);
    }
    const render = SCENE_RENDERERS[scene];
    // Each scene starts from its own beginning.
    const startedAt = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      render(ctx, canvas.width, canvas.height, now - startedAt);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [scene]);

  return (
    <div className={styles.root} data-scene={scene ?? "none"}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    </div>
  );
}
