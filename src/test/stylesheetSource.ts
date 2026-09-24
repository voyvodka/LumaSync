/// <reference types="node" />
// Source-level stylesheet reader for tests. happy-dom applies no stylesheet,
// so CSS guards read the source — and `styles.css` is only an import list.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const STYLESHEET_ENTRY = resolve(process.cwd(), "src", "styles.css");

const LOCAL_IMPORT = /^@import\s+"(\.[^"]+)"[^;\n]*;$/gm;

/** Every local `@import` inlined in cascade order, so a guard sees what the build sees. */
export function readStylesheet(file: string = STYLESHEET_ENTRY): string {
  return readFileSync(file, "utf8").replace(LOCAL_IMPORT, (_, rel: string) =>
    readStylesheet(resolve(dirname(file), rel)),
  );
}
