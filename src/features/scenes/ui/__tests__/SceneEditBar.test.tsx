import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SceneEditBar } from "../SceneEditBar";

function setup(overrides: Partial<Parameters<typeof SceneEditBar>[0]> = {}) {
  const props = {
    label: "Editing Movie",
    name: "",
    placeholder: "Movie",
    swatch: "#f80",
    canSave: true,
    failed: false,
    onName: vi.fn<(name: string) => void>(),
    onSave: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
    ...overrides,
  };
  render(<SceneEditBar {...props} />);
  return props;
}

const field = () => screen.getByTestId("scene-edit-name");

describe("SceneEditBar", () => {
  it("names what is being edited, and shows the scene's own name while the field is empty", () => {
    setup();
    expect(screen.getByRole("group", { name: "Editing Movie" })).toBeInTheDocument();
    expect(field()).toHaveAttribute("placeholder", "Movie");
  });

  it("Enter saves and Esc cancels, from the name field", () => {
    const props = setup();
    fireEvent.change(field(), { target: { value: "Late film" } });
    expect(props.onName).toHaveBeenCalledWith("Late film");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(props.onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  // Off is not a scene.
  it("with nothing to save, Save is off and Enter does nothing", () => {
    const props = setup({ canSave: false });
    expect(screen.getByTestId("scene-edit-save")).toBeDisabled();
    expect(screen.getByTestId("scene-edit-save")).toHaveAttribute("title", "lights:scenes.saveNeedsLight");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("a save that did not land marks the field", () => {
    setup({ failed: true });
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveAttribute("title", "lights:scenes.saveFailed");
  });

  it("offers Reset only where the scene has somewhere to go back to, and not while it is already there", () => {
    const onReset = vi.fn<() => void>();
    const { unmount } = render(
      <SceneEditBar
        label="New scene"
        name=""
        placeholder=""
        swatch="#000"
        canSave
        failed={false}
        onName={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByTestId("scene-edit-reset")).toBeNull();
    unmount();

    setup({ reset: { label: "Back to Movie", done: false, onReset } });
    fireEvent.click(screen.getByRole("button", { name: "Back to Movie" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("Reset is off once the light is back where the scene starts", () => {
    setup({ reset: { label: "Back to Movie", done: true, onReset: () => {} } });
    expect(screen.getByTestId("scene-edit-reset")).toBeDisabled();
  });
});
