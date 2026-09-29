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

const disk: { state: Partial<ShellState>; failNext: boolean; saveFails: boolean } = {
  state: {},
  failNext: false,
  saveFails: false,
};
const writes: Partial<ShellState>[] = [];

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({ ...disk.state }),
    // A save lands a moment later, as a real write does: an apply that did not wait would beat it.
    save: (partial: Partial<ShellState>) =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (disk.saveFails) return reject(new Error("SHELL_STATE_WRITE_FAILED"));
          disk.state = { ...disk.state, ...partial };
          resolve();
        }, 5),
      ),
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

/** A row's fold has had its time (the test DOM runs no animation), and a frame after it. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function openLibrary() {
  await act(async () => fireEvent.click(screen.getByTestId("scene-library-open")));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  disk.state = {};
  disk.failNext = false;
  disk.saveFails = false;
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
    // What Rust reads when it builds the payload is the disk, not this window's store.
    const onApply = vi.fn<Apply>(() => {
      order.push(`apply:${String(disk.state.lightingIntensityPreset)}`);
    });
    renderScenes(OFF, onApply);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Movie" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(order).toEqual(["apply:subtle"]);
  });

  it("still plays the scene when the smoothing cannot be saved, at the smoothing that stays", async () => {
    __resetScenesForTests([
      { id: "m", kind: "ambilight", name: "Movie", ambilight: { brightness: 0.8, lightingSmoothingPreset: "subtle" } },
    ]);
    disk.saveFails = true;
    const onApply = renderScenes(OFF);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Movie" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ kind: "ambilight" }));
    expect(getPreference("lightingIntensityPreset")).toBe("moderate");
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
  it("adds a suggested scene once its row has folded away, and the new one grows in", async () => {
    seed([]);
    renderScenes(OFF);
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-add-fireplace")));
    // The suggestion folds first; the list changes when it has gone.
    expect(getScenes()).toEqual([]);
    await act(settle);
    expect(getScenes()).toEqual([expect.objectContaining({ suggestedId: "fireplace", kind: "effect" })]);
    expect(within(library).queryByTestId("scene-add-fireplace")).not.toBeInTheDocument();
    const id = getScenes()[0]!.id;
    expect(within(library).getByTestId(`scene-entry-${id}`)).toHaveAttribute("data-entering");
    expect(screen.getByTestId(`scene-${id}`)).toHaveAttribute("data-arrived");
  });

  it("opens with nothing arriving: the list already there does not grow in", async () => {
    seed([mine("a", "One")]);
    renderScenes(OFF);
    const library = await openLibrary();
    expect(within(library).getByTestId("scene-entry-a")).not.toHaveAttribute("data-entering");
    expect(screen.getByTestId("scene-a")).not.toHaveAttribute("data-arrived");
  });

  it("sorts by dragging a row: the others step aside, and the drop is the new order", async () => {
    seed([mine("a", "One"), mine("b", "Two"), mine("c", "Three")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const row = within(library).getByTestId("scene-entry-a");
    fireEvent.pointerDown(row, { button: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientY: 12, pointerId: 1 });
    // Under the slop a press is still a press.
    expect(row).not.toHaveAttribute("data-dragged");
    fireEvent.pointerMove(row, { clientY: 10 + 36 * 2, pointerId: 1 });
    expect(row).toHaveAttribute("data-dragged");
    expect(row.style.transform).toBe("translateY(72px)");
    expect(within(library).getByTestId("scene-entry-b").style.transform).toBe("translateY(-36px)");
    await act(async () => fireEvent.pointerUp(row, { pointerId: 1 }));
    expect(getScenes().map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(within(library).getByTestId("scene-entry-a").style.transform).toBe("");
  });

  it("leaves the order alone when a drag ends where it began, or starts on a button", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const row = within(library).getByTestId("scene-entry-a");
    fireEvent.pointerDown(row, { button: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientY: 20, pointerId: 1 });
    await act(async () => fireEvent.pointerUp(row, { pointerId: 1 }));
    fireEvent.pointerDown(within(library).getByTestId("scene-rename-a"), { button: 0, clientY: 10, pointerId: 2 });
    fireEvent.pointerMove(row, { clientY: 100, pointerId: 2 });
    await act(async () => fireEvent.pointerUp(row, { pointerId: 2 }));
    expect(getScenes().map((s) => s.id)).toEqual(["a", "b"]);
    expect(writes).toHaveLength(0);
  });

  it("moves a scene with the arrow keys on its handle, keeping focus there and saying where it went", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    expect(within(library).getByTestId("scene-library")).toHaveFocus();
    const handle = within(library).getByTestId("scene-handle-a");
    handle.focus();
    await act(async () => fireEvent.keyDown(handle, { key: "ArrowUp" }));
    expect(getScenes().map((s) => s.id)).toEqual(["a", "b"]);
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(getScenes().map((s) => s.id)).toEqual(["b", "a"]);
    expect(within(library).getByTestId("scene-handle-a")).toHaveFocus();
    expect(within(library).getByText("lights:scenes.movedTo(One)")).toBeInTheDocument();
  });

  it("closes and hands focus back when focus leaves it for the page's end", async () => {
    seed([mine("a", "One")]);
    renderScenes(OFF);
    const library = await openLibrary();
    await act(async () => fireEvent.blur(within(library).getByTestId("scene-library"), { relatedTarget: null }));
    expect(screen.getByTestId("scene-library-open")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("scene-library-open")).toHaveFocus();
  });

  it("disarms a delete on its own after a moment", async () => {
    vi.useFakeTimers();
    try {
      seed([mine("a", "One")]);
      renderScenes(OFF);
      await act(async () => fireEvent.click(screen.getByTestId("scene-library-open")));
      const remove = screen.getByTestId("scene-remove-a");
      act(() => fireEvent.click(remove));
      expect(remove).toHaveAccessibleName("lights:scenes.removeConfirm(One)");
      act(() => vi.advanceTimersByTime(3000));
      expect(remove).toHaveAccessibleName("lights:scenes.remove(One)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes on the second press only, once the row has folded away", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const remove = within(library).getByTestId("scene-remove-a");
    await act(async () => fireEvent.click(remove));
    expect(getScenes()).toHaveLength(2);
    expect(remove).toHaveAccessibleName("lights:scenes.removeConfirm(One)");
    await act(async () => fireEvent.click(remove));
    expect(within(library).getByTestId("scene-entry-a")).toHaveAttribute("data-leaving");
    await act(settle);
    expect(getScenes().map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps focus in the library when a delete takes the focused row away", async () => {
    seed([mine("a", "One"), mine("b", "Two")]);
    renderScenes(OFF);
    const library = await openLibrary();
    const remove = within(library).getByTestId("scene-remove-a");
    remove.focus();
    await act(async () => fireEvent.click(remove));
    await act(async () => fireEvent.click(remove));
    await act(settle);
    expect(getScenes().map((s) => s.id)).toEqual(["b"]);
    expect(within(library).getByTestId("scene-library")).toHaveFocus();
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
