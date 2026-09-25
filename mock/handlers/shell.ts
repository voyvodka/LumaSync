/**
 * Displays, capture permission, platform, preview, shell state, and the Tauri
 * plugins.
 *
 * Two things here make the browser path usable at all: `get_shell_state` gates
 * startup, and `plugin:log|log` carries every line `main.tsx`'s console bridge
 * forwards. Without both the app never finishes bootstrapping and the console
 * fills with bridge failures.
 */

import { CAPTURE_COMMANDS } from "../../src/shared/contracts/capture";
import { DISPLAY_OVERLAY_COMMANDS } from "../../src/shared/contracts/display";
import { LED_TEST_STATUS, PREVIEW_COMMANDS } from "../../src/shared/contracts/preview";
import { UPDATER_COMMANDS, UPDATER_STATUS } from "../../src/shared/contracts/updater";
import {
  SHELL_COMMANDS,
  SHELL_EVENTS,
  type ShellState,
  type ShellStateChanged,
} from "../../src/shared/contracts/shell";
import { emitMockEvent } from "../events";
import { getWorld, mutate } from "../state";
import { status } from "./status";
import type { Handler, TypedHandlers } from "./types";

/**
 * Backs the shell-state commands the way `commands/shell_state.rs` does: one
 * object, a revision per accepted write, and a change event after each. Seeded
 * from the scenario at first read and then left alone, so edits a developer
 * makes by hand survive until the scenario changes.
 */
let shellStateBacking: Record<string, unknown> | null = null;
let shellStateRevision = 0;
let seededGeneration = -1;

/**
 * Writes a shell-state key so both halves agree. Without this a panel edit
 * lands in `world.shellState`, renders correctly in the panel, and is never
 * seen by `get_shell_state` — `ensureSeeded` only re-reads the world when the
 * generation changes, and a hand edit deliberately does not bump it. A control
 * that looks alive and does nothing is worse than no control.
 */
export function writeShellStateKey(key: string, value: unknown): void {
  ensureSeeded();
  const state = { ...shellStateBacking, [key]: value };
  shellStateBacking = state;
  mutate((w) => {
    w.shellState = state as Partial<ShellState>;
  });
}

/** Removes shell-state keys the way Rust's own writes do: a revision and a
 * change event every window hears. */
export function removeShellStateKeys(keys: readonly string[]): void {
  ensureSeeded();
  const next: Record<string, unknown> = { ...shellStateBacking };
  for (const key of keys) delete next[key];
  shellStateBacking = next;
  shellStateRevision += 1;
  mutate((w) => {
    w.shellState = next as Partial<ShellState>;
  });
  announceShellStateChange({ set: {}, remove: [...keys], revision: shellStateRevision, writerId: "rust" });
}

function ensureSeeded(): void {
  const w = getWorld();
  if (seededGeneration === w.generation) return;
  seededGeneration = w.generation;
  shellStateBacking = w.shellState ? { ...w.shellState } : null;
  shellStateRevision = 0;
}

function refuseWriteIfScenarioSaysSo(): void {
  if (getWorld().persistFails) {
    throw new Error(
      "SHELL_STATE_WRITE_FAILED: [LumaSync][mock] shell-state write refused (scenario: saving fails)",
    );
  }
}

function announceShellStateChange(changed: ShellStateChanged): void {
  void emitMockEvent(SHELL_EVENTS.STATE_CHANGED, changed);
}

export const shellHandlers = {
  // A bare array, not an envelope: `listDisplays()` in calibrationApi.ts is
  // typed `Promise<DisplayInfo[]>` and calls `.find` on the result directly.
  [DISPLAY_OVERLAY_COMMANDS.LIST_DISPLAYS]: () =>
    getWorld().displays.map((d, index) => ({
      id: d.id,
      label: d.name,
      width: d.width,
      height: d.height,
      x: index === 0 ? 0 : 3600,
      y: 0,
      scaleFactor: 2,
      isPrimary: index === 0,
    })),

  // Flat `code`, no envelope. Three of the result types in this file keep the
  // code at the top level rather than under `status` — preview and capture —
  // and guessing the envelope is how the first version of this file went wrong.
  [CAPTURE_COMMANDS.GET_SCREEN_CAPTURE_PERMISSION]: () => ({
    code: getWorld().capture.permissionGranted
      ? ("SCREEN_CAPTURE_PERMISSION_GRANTED" as const)
      : ("SCREEN_CAPTURE_PERMISSION_DENIED" as const),
  }),

  [CAPTURE_COMMANDS.OPEN_SCREEN_CAPTURE_SETTINGS]: () => ({
    code: "SCREEN_CAPTURE_SETTINGS_OPENED" as const,
    message: null,
  }),

  // These address separate webview windows. The status codes let the calling
  // state machine advance and the buttons be exercised; no window appears, and
  // that gap is real.
  [PREVIEW_COMMANDS.OPEN_TWIN_OVERLAY]: () => ({
    ok: true,
    code: "TWIN_OVERLAY_OPENED" as const,
    message: "Opened",
  }),
  [PREVIEW_COMMANDS.CLOSE_TWIN_OVERLAY]: () => ({
    ok: true,
    code: "TWIN_OVERLAY_CLOSED" as const,
    message: "Closed",
  }),
  // `previewOnly` derivation mirrors `start_led_test_pattern`'s target
  // resolution (`src-tauri/src/commands/lighting_mode.rs:3040-3046`):
  // empty/absent `targets` defaults to wanting USB, "hue" opts a target in.
  // A registered WLED sink satisfies the USB channel exactly like a
  // connected serial port does (`UsbOutputPlan::Wled`), and Hue only counts
  // once a stream is actually running with mapped channels —
  // `snapshot_hue_output_context` (`hue/state_store.rs:451-463`) reads
  // `owner.active_stream`, which is `Some` only while genuinely `Running`.
  // `w.hue.streaming` is the mock's proxy for that same fact — see
  // `hueRuntimeFault` in `./hue.ts` and the identical reasoning in
  // `device.ts`'s `SET_LIGHTING_MODE` handler.
  [PREVIEW_COMMANDS.START_TEST_PATTERN]: (args) => {
    const w = getWorld();
    const requested = args.payload.targets ?? [];
    const wantUsb = requested.length === 0 || requested.includes("usb");
    const wantHue = requested.includes("hue");
    const useUsb = (w.serial.connectedPort !== null || w.wled.connectedHost !== null) && wantUsb;
    const useHue = w.hue.streaming && w.hue.channels.length > 0 && wantHue;
    const previewOnly = !useUsb && !useHue;
    return {
      active: true,
      previewOnly,
      status: previewOnly
        ? status(LED_TEST_STATUS.PATTERN_PREVIEW_ONLY, "Preview only — no connected output sink")
        : status(LED_TEST_STATUS.PATTERN_STARTED, "Started"),
    };
  },
  // `stop_led_test_pattern` re-applies the mode that ran before the test and
  // answers with *that* mode's `active`; a restore the USB or Hue gate refuses
  // is forced to Off. The mock's pattern never replaces `lighting.mode`, so that
  // is the prior mode. A seeded mode carries no `targets`, and every scenario
  // seeds one it can run, so only recorded targets are gated.
  [PREVIEW_COMMANDS.STOP_TEST_PATTERN]: () => {
    const w = getWorld();
    const prior = w.lighting.mode;
    const targets = prior.targets;
    const usbAvailable = w.serial.connectedPort !== null || w.wled.connectedHost !== null;
    const gated =
      prior.kind !== "off" &&
      targets !== undefined &&
      targets !== null &&
      (((targets.length === 0 || targets.includes("usb")) && !usbAvailable) ||
        (targets.includes("hue") && !w.hue.streaming));
    if (gated) {
      mutate((draft) => {
        draft.lighting.mode = { ...draft.lighting.mode, kind: "off" };
      });
    }
    const captureRefused = prior.kind === "ambilight" && !w.capture.permissionGranted;
    return {
      active: prior.kind !== "off" && !gated && !captureRefused,
      // Rust hardcodes `preview_only: false` on stop regardless of sink state
      // — the field describes the test that just ended, not whatever mode gets
      // restored in its place.
      previewOnly: false,
      status: status(LED_TEST_STATUS.PATTERN_STOPPED, "Stopped"),
    };
  },

  [UPDATER_COMMANDS.CHECK_FOR_UPDATE]: () => ({
    status: status(UPDATER_STATUS.UP_TO_DATE, "Up to date"),
    channel: "stable" as const,
    update: null,
  }),
  [UPDATER_COMMANDS.DOWNLOAD_AND_INSTALL_UPDATE]: () => ({
    status: status(UPDATER_STATUS.UP_TO_DATE, "Nothing pending"),
  }),

  // A browser tab has no autostart; the window it would hide is the page.
  [SHELL_COMMANDS.GET_LAUNCH_CONTEXT]: () => ({ startHidden: false, e2eBuild: false }),
  // A browser tab has no tray; the document's own visibility is the whole story.
  [SHELL_COMMANDS.GET_MAIN_WINDOW_VISIBILITY]: () => ({ visible: true }),

  [SHELL_COMMANDS.GET_SHELL_STATE]: () => {
    ensureSeeded();
    return {
      state: shellStateBacking ? ({ ...shellStateBacking } as Partial<ShellState>) : null,
      revision: shellStateRevision,
    };
  },
  [SHELL_COMMANDS.PATCH_SHELL_STATE]: ({ patch }) => {
    refuseWriteIfScenarioSaysSo();
    ensureSeeded();
    const next: Record<string, unknown> = { ...shellStateBacking, ...patch.set };
    for (const key of patch.remove) delete next[key];
    shellStateBacking = next;
    shellStateRevision += 1;
    announceShellStateChange({
      set: patch.set,
      remove: [...patch.remove],
      revision: shellStateRevision,
      writerId: patch.writerId ?? null,
    });
    return { applied: true, revision: shellStateRevision };
  },
  // The diff in the event mirrors Rust's: keys whose value changed, and keys gone.
  [SHELL_COMMANDS.REPLACE_SHELL_STATE]: ({ request }) => {
    ensureSeeded();
    if (request.expectedRevision !== shellStateRevision) {
      return { applied: false, revision: shellStateRevision };
    }
    refuseWriteIfScenarioSaysSo();
    const previous: Record<string, unknown> = shellStateBacking ?? {};
    const next = { ...request.state } as Record<string, unknown>;
    const set = Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value),
      ),
    ) as Partial<ShellState>;
    const remove = Object.keys(previous).filter((key) => !(key in next));
    shellStateBacking = next;
    shellStateRevision += 1;
    announceShellStateChange({
      set,
      remove,
      revision: shellStateRevision,
      writerId: request.writerId ?? null,
    });
    return { applied: true, revision: shellStateRevision };
  },
} satisfies TypedHandlers;

/**
 * Tauri routes plugin traffic through `invoke` as `plugin:<name>|<method>`.
 * These are not in any `*COMMANDS` map, so they are matched by prefix rather
 * than by the exhaustiveness guard.
 */

/**
 * `plugin:window|*` and `plugin:webview|*` have well over forty methods between
 * them and the app touches a moving subset, so they are answered by shape
 * rather than enumerated: getters return a plausible value, setters return
 * null. Listing them individually would be a maintenance burden that buys
 * nothing — none of them is a fixture anyone would want to vary per scenario.
 *
 * The sizes are PHYSICAL pixels, which is what Tauri returns; the app divides
 * by `scale_factor` to get logical ones. Returning logical pixels here makes
 * the window arithmetic come out half-size and is not obvious from the symptom.
 */
const WINDOW_SCALE_FACTOR = 2;

function physicalSize(): { width: number; height: number } {
  return {
    width: window.innerWidth * WINDOW_SCALE_FACTOR,
    height: window.innerHeight * WINDOW_SCALE_FACTOR,
  };
}

const MONITOR = {
  name: "Mock Display",
  size: { width: 3600, height: 2338 },
  position: { x: 0, y: 0 },
  scaleFactor: WINDOW_SCALE_FACTOR,
  workArea: { position: { x: 0, y: 0 }, size: { width: 3600, height: 2250 } },
};

export function windowPluginHandler(command: string): Handler | undefined {
  if (!command.startsWith("plugin:window|") && !command.startsWith("plugin:webview|")) {
    return undefined;
  }
  const method = command.split("|")[1] ?? "";

  if (method === "scale_factor") return () => WINDOW_SCALE_FACTOR;
  if (method === "inner_size" || method === "outer_size") return () => physicalSize();
  if (method === "inner_position" || method === "outer_position" || method === "cursor_position") {
    return () => ({ x: 0, y: 0 });
  }
  if (method === "current_monitor" || method === "primary_monitor" || method === "monitor_from_point") {
    return () => MONITOR;
  }
  if (method === "available_monitors") return () => [MONITOR];
  if (method === "get_all_windows") return () => ["main"];
  if (method === "theme") return () => "dark";
  if (method === "title") return () => "LumaSync";
  if (method.startsWith("is_")) {
    // Visible and focused; everything else off. A window that reports itself
    // hidden makes the shell bootstrap wait for a show that never comes.
    return () => method === "is_visible" || method === "is_focused" || method === "is_resizable";
  }
  return () => null;
}

export const pluginHandlers: Record<string, Handler> = {
  // The console bridge calls these for every forwarded line. Answering null
  // keeps them quiet; the browser console already shows the original call.
  "plugin:log|log": () => null,

  "plugin:window-state|save_window_state": () => null,
  "plugin:window-state|restore_state": () => null,
  "plugin:notification|is_permission_granted": () =>
    getWorld().shell.notificationPermission === "granted",
  "plugin:notification|request_permission": () => getWorld().shell.notificationPermission,
  "plugin:notification|notify": () => null,
  "plugin:autostart|is_enabled": () => getWorld().shell.autostartEnabled,
  "plugin:autostart|enable": () => null,
  "plugin:autostart|disable": () => null,
  "plugin:opener|open_url": () => null,
  "plugin:opener|open_path": () => null,
  "plugin:updater|check": () => null,
  "plugin:process|restart": () => null,
  // `plugin:event|*` is deliberately absent. Answering `listen` here made the
  // shim resolve before `mockIPC`'s event registry ever saw the call, so every
  // Tauri event was silently dead — including `ambilight://edge-signal`, which
  // meant the signal readout showed zeros in *every* scenario and the mock
  // could not tell the bug it was built to reproduce from its own limitation.
  // Leaving them unhandled lets mockIPC own them in the browser and lets
  // passthrough reach the real subscription under `tauri:mock`.
};
