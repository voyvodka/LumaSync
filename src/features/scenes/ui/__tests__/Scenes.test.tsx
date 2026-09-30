import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests, getPreference } from "@/features/persistence/preferences";
import { normalizeEffectPayload, type LightingModeConfig } from "@/shared/contracts/mode";
import type { StoredScene } from "@/shared/contracts/scenes";
import type { ShellState } from "@/shared/contracts/shell";

import { __resetScenesForTests, editScenes, getScenes } from "../../state/scenesStore";
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

  it("holds a press while a choice is in flight, without dimming the chips", async () => {
    seed([mine("a", "Blue")]);
    const onApply = vi.fn<Apply>();
    render(<Scenes mode={OFF} disabled={false} busy onApply={onApply} />);
    const chip = screen.getByRole("radio", { name: "Blue" });
    expect(chip).toBeEnabled();
    await act(async () => fireEvent.click(chip));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("does not play a scene this build cannot, nor any while disabled", () => {
    seed([{ id: "f", kind: "music" as never, name: "Future" }, mine("a", "Blue")]);
    renderScenes(OFF, vi.fn<Apply>(), true);
    expect(screen.getByRole("radio", { name: "Future" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Blue" })).toBeDisabled();
  });

  it("cannot make a scene of Off, and offers the first one in an empty list's place", async () => {
    seed([]);
    const view = render(<Scenes mode={OFF} disabled={false} onApply={vi.fn<Apply>()} />);
    expect(screen.getByTestId("scene-save")).toBeDisabled();
    expect(screen.getByTestId("scene-save-first")).toBeDisabled();
    view.rerender(<Scenes mode={RED} disabled={false} onApply={vi.fn<Apply>()} />);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save-first")));
    expect(screen.getByRole("group", { name: "lights:scenes.save" })).toBeInTheDocument();
  });
});

describe("making and editing a scene", () => {
  const blue = (brightness: number): LightingModeConfig => ({ kind: "solid", solid: { r: 0, g: 0, b: 255, brightness } });
  let setLight: (mode: LightingModeConfig) => void = () => {};

  /** The page around the row: what the row applies runs, and the page's own controls change the light. */
  function Page({ initial, onApply, busy = false }: { initial: LightingModeConfig; onApply: Apply; busy?: boolean }) {
    const [mode, setMode] = useState(initial);
    setLight = (next) => act(() => setMode(next));
    return (
      <Scenes
        mode={mode}
        disabled={false}
        busy={busy}
        onApply={(next) => {
          onApply(next);
          setMode(next);
        }}
      />
    );
  }

  function renderPage(initial: LightingModeConfig, busy = false) {
    const onApply = vi.fn<Apply>();
    const view = render(<Page initial={initial} onApply={onApply} busy={busy} />);
    return { onApply, view };
  }

  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const bar = () => screen.queryByRole("group", { name: /lights:scenes\.(save|editing)/ });

  async function editFromLibrary(id: string) {
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId(`scene-edit-${id}`)));
    await frame();
  }

  it("opens on the row: no edit is open until one is asked for", () => {
    seed([mine("a", "Blue")]);
    renderPage(RED);
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByTestId("scene-edit").closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Blue" })).toBeInTheDocument();
  });

  it("makes a new scene from the running light, changed and named before it is saved", async () => {
    seed([mine("a", "Blue")]);
    const { onApply } = renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    await frame();
    const name = screen.getByTestId("scene-edit-name");
    expect(bar()).toHaveAccessibleName("lights:scenes.save");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("placeholder", "#FF0000");
    // Nothing is written while it is open.
    expect(getScenes()).toHaveLength(1);

    setLight(blue(0.4));
    fireEvent.change(name, { target: { value: "  Evening  " } });
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-save")));
    await frame();
    const saved = getScenes();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ name: "Evening", kind: "solid", solid: { brightness: 0.4 } });
    expect(disk.state.scenes).toEqual(saved);
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Evening" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Evening" })).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("edits a scene from the library: plays it, and writes the change and the name into it alone", async () => {
    seed([mine("a", "Blue"), mine("b", "Other")]);
    const { onApply } = renderPage(RED);
    await editFromLibrary("a");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).toHaveBeenLastCalledWith(blue(1));
    expect(bar()).toHaveAccessibleName("lights:scenes.editing(Blue)");
    const name = screen.getByTestId("scene-edit-name");
    expect(name).toHaveValue("Blue");
    expect(name).toHaveFocus();

    setLight({ kind: "effect", effect: normalizeEffectPayload({ id: "wave", brightness: 0.5 }) });
    fireEvent.change(name, { target: { value: "Night" } });
    await act(async () => fireEvent.keyDown(name, { key: "Enter" }));
    expect(getScenes().map((s) => s.id)).toEqual(["a", "b"]);
    expect(getScenes()[0]).toMatchObject({ id: "a", name: "Night", kind: "effect", effect: { id: "wave" } });
    expect(getScenes()[0]).not.toHaveProperty("solid");
    expect(getScenes()[1]).toEqual(mine("b", "Other"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("keeps a library scene's own name while the field is left empty", async () => {
    seed([suggestedSceneLike()]);
    renderPage(OFF);
    await editFromLibrary("s");
    const name = screen.getByTestId("scene-edit-name");
    expect(name).toHaveValue("");
    expect(name).toHaveAttribute("placeholder", "lights:scenes.suggested.movie");
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-save")));
    expect(getScenes()[0]).toEqual(expect.objectContaining({ suggestedId: "movie", kind: "ambilight" }));
    expect(getScenes()[0]).not.toHaveProperty("name");
  });

  it("puts the light and its smoothing back as they were on Cancel, and keeps the scene as it was", async () => {
    const movie: StoredScene = {
      id: "m",
      kind: "ambilight",
      name: "Movie",
      ambilight: { brightness: 0.8, lightingSmoothingPreset: "subtle" },
    };
    seed([movie]);
    const { onApply } = renderPage(RED);
    await editFromLibrary("m");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(getPreference("lightingIntensityPreset")).toBe("subtle");
    setLight(blue(0.3));

    await act(async () => {
      fireEvent.click(screen.getByTestId("scene-edit-cancel"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await frame();
    expect(onApply).toHaveBeenLastCalledWith(RED);
    expect(getPreference("lightingIntensityPreset")).toBe("moderate");
    expect(getScenes()).toEqual([movie]);
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Movie" })).toHaveFocus();
  });

  it("applies nothing on Cancel when nothing changed, nor on opening the scene already running", async () => {
    seed([mine("a", "Blue")]);
    const { onApply } = renderPage(blue(1));
    await editFromLibrary("a");
    await act(async () => fireEvent.keyDown(screen.getByTestId("scene-edit-name"), { key: "Escape" }));
    expect(bar()).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("has nothing to save while the lights are off, and Enter then saves nothing", async () => {
    seed([mine("a", "Blue")]);
    renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    setLight(OFF);
    expect(screen.getByTestId("scene-edit-save")).toBeDisabled();
    await act(async () => fireEvent.keyDown(screen.getByTestId("scene-edit-name"), { key: "Enter" }));
    expect(getScenes()).toHaveLength(1);
    expect(bar()).toBeInTheDocument();
  });

  it("holds Cancel while a choice is in flight", async () => {
    seed([mine("a", "Blue")]);
    const { onApply, view } = renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    setLight(blue(0.3));
    view.rerender(<Page initial={RED} onApply={onApply} busy />);
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-cancel")));
    expect(bar()).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("closes when the scene it edits is deleted meanwhile", async () => {
    seed([mine("a", "Blue")]);
    renderPage(RED);
    await editFromLibrary("a");
    await act(async () => {
      await editScenes(() => []);
    });
    expect(bar()).not.toBeInTheDocument();
  });

  it("puts the list back when the save fails, and the edit with it, name and all", async () => {
    seed([mine("a", "Blue")]);
    renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    fireEvent.change(screen.getByTestId("scene-edit-name"), { target: { value: "Evening" } });
    disk.failNext = true;
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-save")));
    expect(getScenes().map((s) => s.id)).toEqual(["a"]);
    expect(screen.queryByRole("radio", { name: "Evening" })).not.toBeInTheDocument();
    expect(bar()).toBeInTheDocument();
    expect(screen.getByTestId("scene-edit-name")).toHaveValue("Evening");
    expect(screen.getByTestId("scene-edit-name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("lights:scenes.saveFailed")).toBeInTheDocument();
  });

  it("does not turn the lights back on when Cancel comes after they were turned off", async () => {
    seed([mine("a", "Blue")]);
    const { onApply } = renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    setLight(OFF);
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-cancel")));
    expect(bar()).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    // "+" cannot take focus with the lights off: the library button does.
    await frame();
    expect(screen.getByTestId("scene-library-open")).toHaveFocus();
  });

  it("opens no edit while the scenes are locked", async () => {
    seed([mine("a", "Blue")]);
    const onApply = vi.fn<Apply>();
    render(<Scenes mode={RED} disabled onApply={onApply} />);
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-edit-a")));
    expect(bar()).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("writes on the list as stored, not on a stale copy", async () => {
    __resetScenesForTests([mine("a", "Blue")]);
    // Another write landed on disk after this window last read it.
    disk.state = { scenes: [mine("a", "Blue"), mine("z", "Other")] };
    renderPage(RED);
    await act(async () => fireEvent.click(screen.getByTestId("scene-save")));
    await act(async () => fireEvent.click(screen.getByTestId("scene-edit-save")));
    expect((disk.state.scenes ?? []).map((s) => s.id).slice(0, 2)).toEqual(["a", "z"]);
    expect(disk.state.scenes).toHaveLength(3);
  });

  it("cannot open a scene this build cannot play", async () => {
    seed([{ id: "f", kind: "music" as never, name: "Future" }]);
    renderPage(RED);
    const library = await openLibrary();
    expect(within(library).getByTestId("scene-edit-f")).toBeDisabled();
  });
});

describe("the scene library", () => {
  it("adds a suggested scene at once: it travels up to the list rather than growing in there", async () => {
    seed([]);
    renderScenes(OFF);
    const library = await openLibrary();
    await act(async () => fireEvent.click(within(library).getByTestId("scene-add-fireplace")));
    expect(getScenes()).toEqual([expect.objectContaining({ suggestedId: "fireplace", kind: "effect" })]);
    expect(within(library).queryByTestId("scene-add-fireplace")).not.toBeInTheDocument();
    const id = getScenes()[0]!.id;
    expect(within(library).getByTestId(`scene-entry-${id}`)).not.toHaveAttribute("data-entering");
    // The chip behind the popover has no suggestion to come from: it grows in.
    expect(screen.getByTestId(`scene-${id}`)).toHaveAttribute("data-arrived");
  });

  it("puts a deleted suggestion back among the suggestions, fading in", async () => {
    seed([{ id: "s", suggestedId: "movie", kind: "ambilight", ambilight: { brightness: 0.8 } }]);
    renderScenes(OFF);
    const library = await openLibrary();
    expect(within(library).queryByTestId("scene-add-movie")).not.toBeInTheDocument();
    const remove = within(library).getByTestId("scene-remove-s");
    await act(async () => fireEvent.click(remove));
    await act(async () => fireEvent.click(remove));
    await act(settle);
    expect(within(library).getByTestId("scene-add-movie").closest("li")).toHaveAttribute("data-entering");
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
    fireEvent.pointerDown(within(library).getByTestId("scene-edit-a"), { button: 0, clientY: 10, pointerId: 2 });
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
});

function suggestedSceneLike(): StoredScene {
  return { id: "s", suggestedId: "movie", kind: "ambilight", ambilight: { brightness: 0.8 } };
}
