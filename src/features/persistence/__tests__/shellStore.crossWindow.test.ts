// Two windows, one Rust-owned file. Each "window" is its own module graph —
// its own write queue, writer id and listeners — reaching one stand-in for
// `commands/shell_state.rs` through the real invoke bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHELL_COMMANDS, SHELL_STATE_SCHEMA_VERSION } from "@/shared/contracts/shell";
import { createFakeShellStateBackend } from "@/test/fakeShellStateBackend";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

let backend = createFakeShellStateBackend();
let invokeThrough: Invoke = (command, args) =>
  backend.invoke(command, args) ?? Promise.reject(new Error(`unexpected invoke: ${command}`));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeThrough(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { event: string; payload: unknown }) => void) =>
    backend.listen(event, handler),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

async function openWindow() {
  vi.resetModules();
  return import("@/features/persistence/shellStore");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  backend = createFakeShellStateBackend({ schemaVersion: SHELL_STATE_SCHEMA_VERSION });
  invokeThrough = (command, args) =>
    backend.invoke(command, args) ?? Promise.reject(new Error(`unexpected invoke: ${command}`));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two windows writing the same shell state", () => {
  it("keeps both windows' keys when they patch at the same time", async () => {
    backend.useMacrotaskLatency(true);
    const main = await openWindow();
    const popup = await openWindow();
    expect(main.saveShellState).not.toBe(popup.saveShellState);

    await Promise.all([
      main.shellStore.save({ lastSection: "devices" }),
      popup.shellStore.save({ ledPreviewPopupCenterX: 640, ledPreviewPopupCenterY: 400 }),
      main.shellStore.save({ uiMode: "full" }),
      popup.shellStore.save({ lastLedTestPattern: { kind: "gamut" } }),
    ]);

    expect(await main.shellStore.load()).toMatchObject({
      lastSection: "devices",
      uiMode: "full",
      ledPreviewPopupCenterX: 640,
      ledPreviewPopupCenterY: 400,
      lastLedTestPattern: { kind: "gamut" },
    });
    expect(await popup.shellStore.load()).toEqual(await main.shellStore.load());
  });

  it("tells one window's listeners about the other window's save, once", async () => {
    const main = await openWindow();
    const popup = await openWindow();
    const heardInMain: unknown[] = [];
    const heardInPopup: unknown[] = [];
    main.shellStore.onSaved((saved) => heardInMain.push(saved));
    popup.shellStore.onSaved((saved) => heardInPopup.push(saved));

    await popup.shellStore.save({ ledTwinEnabledTest: false, lastSuccessfulPort: undefined });
    await flush();

    expect(heardInMain).toEqual([{ ledTwinEnabledTest: false, lastSuccessfulPort: undefined }]);
    expect(heardInPopup).toEqual([{ ledTwinEnabledTest: false, lastSuccessfulPort: undefined }]);
  });
});

describe("the migration write-back", () => {
  const LEGACY = { schemaVersion: 5, lastSection: "lights", hueChannelRegionOverrides: {} };

  it("replaces the stored object when nothing else wrote in between", async () => {
    backend.seed(LEGACY);
    const main = await openWindow();

    const loaded = await main.shellStore.load();

    expect(loaded.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(backend.state()).toMatchObject({ schemaVersion: SHELL_STATE_SCHEMA_VERSION });
    expect(backend.state()).not.toHaveProperty("hueChannelRegionOverrides");
    expect(backend.replaces()).toHaveLength(1);
  });

  it("re-migrates instead of overwriting a patch that landed after its read", async () => {
    backend.seed(LEGACY);
    const popup = await openWindow();
    const main = await openWindow();
    let raced = false;
    invokeThrough = async (command, args) => {
      const answer = await backend.invoke(command, args);
      if (command === SHELL_COMMANDS.GET_SHELL_STATE && !raced) {
        raced = true;
        // The popup's save lands between the main window's read and write-back.
        await popup.shellStore.save({ ledPreviewHintShown: true });
      }
      return answer;
    };

    const loaded = await main.shellStore.load();

    expect(loaded.ledPreviewHintShown).toBe(true);
    expect(backend.state()).toMatchObject({
      schemaVersion: SHELL_STATE_SCHEMA_VERSION,
      ledPreviewHintShown: true,
    });
    expect(backend.state()).not.toHaveProperty("hueChannelRegionOverrides");
  });

  it("returns the migrated state when the write-back is refused outright", async () => {
    backend.seed(LEGACY);
    const twin = await openWindow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeThrough = (command, args) =>
      command === SHELL_COMMANDS.REPLACE_SHELL_STATE
        ? Promise.reject("replace_shell_state not allowed on window led-twin-overlay-0")
        : backend.invoke(command, args)!;

    const loaded = await twin.shellStore.load();

    expect(loaded.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(loaded).not.toHaveProperty("hueChannelRegionOverrides");
    expect(backend.state()).toMatchObject({ schemaVersion: 5 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] migration: write-back failed"),
      expect.anything(),
    );
  });

  it("writes back a legacy state that carries no version at all", async () => {
    backend.seed({ lastSection: "system" });
    const main = await openWindow();

    await main.shellStore.load();

    expect(backend.state()).toMatchObject({
      lastSection: "system",
      schemaVersion: SHELL_STATE_SCHEMA_VERSION,
    });
  });

  it("leaves a current state alone", async () => {
    const main = await openWindow();

    await main.shellStore.load();

    expect(backend.replaces()).toHaveLength(0);
    expect(backend.revision()).toBe(0);
  });
});
