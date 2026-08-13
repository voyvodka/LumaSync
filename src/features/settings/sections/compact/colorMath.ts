export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Rec. 709 relative luminance — picks black or white text against tile bg. */
export function perceivedLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Luminance above which the hero tile switches to dark label text. */
export const HERO_LIGHT_TILE_THRESHOLD = 0.62;
