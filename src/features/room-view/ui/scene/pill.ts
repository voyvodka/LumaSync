// A short label drawn into a texture, for a tag that stands in the room facing the camera.
import { CanvasTexture, SRGBColorSpace } from "three";

export interface Pill {
  texture: CanvasTexture;
  aspect: number;
  /** Draws `text` again in place; true when its width changed. */
  set(text: string): boolean;
}

export function pillTexture(px: number, colour: string | null, weight: number): Pill {
  const canvas = document.createElement("canvas");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Drawn at twice the screen's pixels, so it stays sharp shrunk to `px`.
  const height = Math.round(px * 2 * Math.max(window.devicePixelRatio || 1, 1));
  const size = Math.round(height * 0.5);
  const css = getComputedStyle(document.body);
  const font = `${weight} ${size}px ${css.fontFamily || "sans-serif"}`;
  const ink = css.getPropertyValue("--lm-ink").trim() || "white";
  const r = height / 2;
  canvas.height = height;
  canvas.width = height;
  let shown = "";
  const pill: Pill = {
    texture,
    aspect: 1,
    set(text) {
      shown = text;
      const context = canvas.getContext("2d");
      if (!context) return false;
      const before = pill.aspect;
      context.font = font;
      const inset = colour ? r * 1.7 : r * 0.9;
      canvas.width = Math.ceil(context.measureText(text).width + inset + r * 0.9);
      canvas.height = height;
      const width = canvas.width;
      // Nearly solid: a tag on the TV's glow lost its text through a lighter pill.
      context.fillStyle = "rgba(14, 14, 20, 0.92)";
      // Two arcs, not `roundRect`: the WebKit of the oldest macOS supported has none.
      context.beginPath();
      context.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
      context.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
      context.fill();
      if (colour) {
        context.fillStyle = colour;
        context.beginPath();
        context.arc(r, r, size * 0.24, 0, Math.PI * 2);
        context.fill();
      }
      context.font = font;
      context.fillStyle = ink;
      context.textBaseline = "middle";
      context.fillText(text, inset, r + 1);
      texture.needsUpdate = true;
      pill.aspect = width / height;
      return pill.aspect !== before;
    },
  };
  // A text drawn before the app's font loaded would keep the fallback for good.
  if (document.fonts && !document.fonts.check(font)) void document.fonts.ready.then(() => shown && pill.set(shown));
  return pill;
}
