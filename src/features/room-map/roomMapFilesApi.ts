/** The room map's file access: picking a background image and reading one back.
 * The only importer of `plugin-dialog` and `plugin-fs`, so their capability
 * scope has a single caller to audit. */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

/** Native single-file picker for a PNG/JPEG; `null` when the user cancels. */
export function pickRoomMapImage(): Promise<string | null> {
  return open({
    multiple: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
  });
}

export function readRoomMapImage(path: string): Promise<Uint8Array<ArrayBuffer>> {
  return readFile(path);
}
