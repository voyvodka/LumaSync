/**
 * windowShellState — the write queue behind `saveShellState`. Doubles and mock
 * strategy: `./support/windowTestHarness`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";
import { saveShellState } from "../windowShellState";
import { backend, makePersistedState, setupPersistedState } from "./support/windowTestHarness";

const harness = await vi.hoisted(() => import("./support/windowTestHarness"));

vi.mock("@tauri-apps/api/core", () => harness.tauriCoreModule);
vi.mock("@tauri-apps/api/window", () => harness.tauriWindowModule);
vi.mock("@tauri-apps/api/event", () => harness.tauriEventModule);
vi.mock("../launchApi", () => harness.launchApiModule);

beforeEach(() => {
  harness.resetWindowHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 9 — concurrent writers
// ---------------------------------------------------------------------------

describe("Scenario 9 — concurrent saveShellState calls do not revert each other", () => {
  /** Answer on a later macrotask, not a microtask — otherwise the first writer
   * always finishes before the second one is sent and nothing interleaves. */
  function usePersistentStore(initial: ShellState) {
    setupPersistedState(initial);
    backend.useMacrotaskLatency(true);
    return () => backend.state() as unknown as ShellState;
  }

  it("keeps both fields when two writers start from the same snapshot", async () => {
    const read = usePersistentStore(makePersistedState({}));

    await Promise.all([
      saveShellState({ lastSection: "devices" }),
      saveShellState({ hasCompletedOnboarding: true }),
    ]);

    expect(read().lastSection).toBe("devices");
    expect(read().hasCompletedOnboarding).toBe(true);
  });

  it("a rejected write does not wedge the writes queued behind it", async () => {
    const read = usePersistentStore(makePersistedState({}));
    backend.failNextWrite(new Error("disk full"));

    await expect(saveShellState({ lastSection: "devices" })).rejects.toThrow("disk full");
    await saveShellState({ hasCompletedOnboarding: true });

    expect(read().hasCompletedOnboarding).toBe(true);
  });

  it("sends an undefined value as a removal, so the key leaves the file", async () => {
    const read = usePersistentStore(
      makePersistedState({ hueAppKey: "plain-user", hueClientKey: "plain-key" }),
    );

    await saveShellState({
      hueAppKey: undefined,
      hueClientKey: undefined,
      credentialStorageBackend: "keychain",
    });

    expect(read()).not.toHaveProperty("hueAppKey");
    expect(read()).not.toHaveProperty("hueClientKey");
    expect(read().credentialStorageBackend).toBe("keychain");
    const patches = backend.patches();
    expect(patches[patches.length - 1].remove).toEqual(["hueAppKey", "hueClientKey"]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — the write queue survives a failure and holds its order
// ---------------------------------------------------------------------------

describe("Scenario 10 — the write queue under load and failure", () => {
  /** Same macrotask-delayed backend as Scenario 9. */
  function usePersistentStore() {
    backend.useMacrotaskLatency(true);
    return () => backend.state();
  }

  it("keeps every field across a burst of overlapping writes", async () => {
    const read = usePersistentStore();

    await Promise.all([
      saveShellState({ language: "en" }),
      saveShellState({ trayHintShown: true }),
      saveShellState({ showNerdStats: true }),
      saveShellState({ hasCompletedOnboarding: false }),
      saveShellState({ lastSuccessfulPort: "/dev/ttyUSB0" }),
    ]);

    expect(read()).toMatchObject({
      language: "en",
      trayHintShown: true,
      showNerdStats: true,
      hasCompletedOnboarding: false,
      lastSuccessfulPort: "/dev/ttyUSB0",
    });
  });

  it("applies writes in the order they were issued", async () => {
    const read = usePersistentStore();

    await Promise.all([
      saveShellState({ language: "en" }),
      saveShellState({ language: "tr" }),
    ]);

    expect(read()?.language).toBe("tr");
  });

  it("surfaces a failed write to its own caller", async () => {
    usePersistentStore();
    backend.failNextWrite(new Error("disk full"));

    await expect(saveShellState({ language: "tr" })).rejects.toThrow("disk full");
  });

  it("does not wedge the queue after a failure", async () => {
    const read = usePersistentStore();
    backend.failNextWrite(new Error("disk full"));

    await expect(saveShellState({ language: "tr" })).rejects.toThrow();
    // Without the `.catch(() => {})` on the queue tail this never resolves.
    await saveShellState({ trayHintShown: true });

    expect(read()).toMatchObject({ trayHintShown: true });
  });
});

