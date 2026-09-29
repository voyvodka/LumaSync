import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests, getPreference } from "@/features/persistence/preferences";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import type { StoredScene } from "@/shared/contracts/scenes";
import type { ShellState } from "@/shared/contracts/shell";

import { __resetScenesForTests, getScenes } from "../../state/scenesStore";
import { Scenes } from "../Scenes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}(${String(opts.name)})` : key),
  }),
}));

const disk: { state: Partial<ShellState>; failNext: boolean } = { state: {}, failNext: false };
const writes: Partial<ShellState>[] = [];

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({ ...disk.state }),
    save: (partial: Partial<ShellState>) => {
      disk.state = { ...disk.state, ...partial };
      return Promise.resolve();
    },
    update: (fn: (s: Partial<ShellState>) => Partial<ShellState> | null) => {
      if (disk.failNext) {
        disk.failNext = false;
        return Promise.reject(new Error("SHELL_STATE_WRITE_FAILED"));
      }
      const patch = fn({ ...disk.state });
      if (patch) {
        writes.push(patch);
        disk.state = { ...disk.state, ...patch };
      }
      return Promise.resolve(disk.state);
    },
    onSaved: () => () => {},
  },
}));

const OFF: LightingModeConfig = { kind: "off" };
const RED: LightingModeConfig = { kind: "solid", solid: { r: 255, g: 0, b: 0, brightness: 0.6 } };
const mine = (id: string, name?: string): StoredScene => ({
  id,
  kind: "solid",
  solid: { r: 0, g: 0, b: 255, brightness: 1 },
  ...(name ? { name } : {}),
});

/** The list as this window holds it and as it is stored. */
function seed(scenes: StoredScene[]) {
  disk.state = { ...disk.state, scenes };
  __resetScenesForTests(scenes);
}

type Apply = (next: LightingModeConfig) => void;

function renderScenes(mode: LightingModeConfig, onApply = vi.fn<Apply>(), disabled = false) {
  render(<Scenes mode={mode} disabled={disabled} onApply={onApply} />);
  return onApply;
}

async function openLibrary() {
  await act(async () => fireEvent.click(screen.getByTestId("scene-library-open")));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  disk.state = {};
  disk.failNext = false;
  writes.length = 0;
  __resetPreferencesForTests();
  __setPreferenceForTests("lightingIntensityPreset", "moderate");
});
// Unmounted first: a reset under a mounted row would re-render it outside act.
afterEach(() => {
  cleanup();
  __resetScenesForTests();
});

describe("Scenes", () => {
  it("applies a scene's look on a press", async () => {
    seed([mine("a", "Blue")]);
    const onApply = renderScenes(OFF);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Blue" })));
    expect(onApply).toHaveBeenCalledWith({ kind: "solid", solid: { r: 0, g: 0, b: 255, brightness: 1 } });
  });

  it("saves an Ambilight scene's smoothing before it applies the scene", async () => {
    const order: string[] = [];
    seed([
      { id: "m", kind: "ambilight", name: "Movie", ambilight: { brightness: 0.8, lightingSmoothingPreset: "subtle" } },
    ]);
    const onApply = vi.fn<Apply>(() => {
      order.push(`apply:${getPreference("lightingIntensityPreset")}`);
    });
    renderScenes(OFF, onApply);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Movie" })));
    expect(order).toEqual(["apply:subtle"]);
    expect(disk.state.lightingIntensityPreset).toBe("subtle");
  });

  it("does not play a scene this build cannot, nor any while disabled", () => {
    seed([{ id: "f", kind: "music" as never, name: "Future" }, mine("a", "Blue")]);
    renderScenes(OFF, vi.fn<Apply>(), true);
    expect(screen.getByRole("radio", { name: "Future" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Blue" })).toBeDisabled();
  });

  it("saves the running light as a new scene, and not twice", async () => {
    seed([mine("a", "Blue")]);
    renderScenes(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    const saved = getScenes();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ kind: "solid", solid: { r: 255, g: 0, b: 0, brightness: 0.6 } });
    expect(disk.state.scenes).toEqual(saved);
    // It is the running light now: checked, and save has nothing new to keep.
    expect(screen.getByRole("radio", { name: "#FF0000" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("scene-save")).toBeDisabled();
  });

  it("cannot save Off, and offers the first save in an empty list's place", async () => {
    seed([]);
    renderScenes(OFF);
    expect(screen.getByTestId("scene-save")).toBeDisabled();
    expect(screen.getByTestId("scene-save-first")).toBeDisabled();
  });

  it("puts the list back when the save fails", async () => {
    seed([mine("a", "Blue")]);
    renderScenes(RED);
    disk.failNext = true;
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    expect(getScenes().map((s) => s.id)).toEqual(["a"]);
    expect(screen.queryByRole("radio", { name: "#FF0000" })).not.toBeInTheDocument();
  });

  it("writes an edit on the list as stored, not on a stale copy", async () => {
    __resetScenesForTests([mine("a", "Blue")]);
    // Another write landed on disk after this window last read it.
    disk.state = { scenes: [mine("a", "Blue"), mine("z", "Other")] };
    renderScenes(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    expect((disk.state.scenes ?? []).map((s) => s.id).slice(0, 2)).toEqual(["a", "z"]);
    expect(disk.state.scenes).toHaveLength(3);
  });
});

describe("the scene library", () => {
  it("adds a suggested scene that is not in the list yet", async () => {
    seed([]);
    renderScenes(OFF);
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-add-fireplace")));
    expect(getScenes()).toEqual([expect.objectContaining({ suggestedId: "fireplace", kind: "effect" })]);
    expect(within(library).queryByTestId("scene-add-fireplace")).not.toBeInTheDocument();
  });

  it("moves a scene a place", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    expect(within(library).getByTestId("scene-up-a")).toBeDisabled();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-down-a")));
    expect(getScenes().map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("deletes on the second press only", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const remove = within(library).getByTestId("scene-remove-a");
    await act(async () => fireEvent.click(remove));
    expect(getScenes()).toHaveLength(2);
    expect(remove).toHaveAccessibleName("lights:scenes.removeConfirm(One)");
    await act(async () => fireEvent.click(remove));
    expect(getScenes().map((s) => s.id)).toEqual(["b"]);
  });

  it("disarms a delete when focus leaves it", async () => {
    seed([mine("a", "One")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const remove = within(library).getByTestId("scene-remove-a");
    await act(async () => fireEvent.click(remove));
    act(() => fireEvent.blur(remove));
    await act(async () => fireEvent.click(remove));
    expect(getScenes()).toHaveLength(1);
  });

  it("renames in place: Enter keeps it, Esc keeps nothing", async () => {
    seed([suggestedSceneLike()]);
    renderScenes(OFF);
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-rename-s")));
    const input = within(library).getByTestId("scene-name-input-s");
    fireEvent.change(input, { target: { value: "  Cinema  " } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(getScenes()[0]!.name).toBe("Cinema");

    await act(async () => fireEvent.click(within(library).getByTestId("scene-rename-s")));
    const again = within(library).getByTestId("scene-name-input-s");
    fireEvent.change(again, { target: { value: "Nope" } });
    await act(async () => fireEvent.keyDown(again, { key: "Escape" }));
    expect(getScenes()[0]!.name).toBe("Cinema");
    // The popover stayed open: the field took the Esc.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

function suggestedSceneLike(): StoredScene {
  return { id: "s", suggestedId: "movie", kind: "ambilight", ambilight: { brightness: 0.8 } };
}
