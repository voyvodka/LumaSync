import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LightingModeConfig } from "@/shared/contracts/mode";
import { renderWithShellStores } from "@/test/shellProviders";

import { RoomLights } from "../RoomLights";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, values?: { mode?: string }) => (values?.mode ? `${key}:${values.mode}` : key) }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: () => Promise.resolve(),
    onSaved: () => () => {},
  },
}));

async function renderLights(lightingMode: LightingModeConfig) {
  const changeMode = vi.fn<(next: LightingModeConfig) => void>();
  await act(async () => {
    renderWithShellStores(<RoomLights />, {
      hue: { configured: true, reachable: true, probeVerdict: "reachable" },
      lighting: { lightingMode, outputTargets: ["hue"], localSink: null, bootstrapDone: true },
      lightingActions: { changeMode },
    });
  });
  return changeMode;
}

afterEach(cleanup);

describe("RoomLights", () => {
  it("names the running mode and opens the everyday controls under it", async () => {
    await renderLights({ kind: "ambilight", ambilight: { brightness: 0.4 } });
    const trigger = screen.getByTestId("room-lights");
    expect(trigger).toHaveAttribute("aria-label", expect.stringContaining("roomMap:view.lightsControl"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger.querySelector("[data-lit]")).not.toBeNull();
    expect(screen.queryByTestId("mode-button-solid")).toBeNull();

    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "roomMap:view.allLights" })).toBeInTheDocument();
    expect(screen.getByTestId("mode-button-solid")).toBeInTheDocument();
    // Rendered into the body, the popover would be the last stop for Tab: focus starts on the running mode.
    expect(document.activeElement).toBe(screen.getByTestId("mode-button-ambilight"));
    // The room's popover carries no scenes: those stay on the Lights page and the tray.
    expect(screen.queryByRole("radio", { name: /lights:scenes\.suggested/ })).toBeNull();

    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("changes every light's mode from the room", async () => {
    const changeMode = await renderLights({ kind: "ambilight", ambilight: { brightness: 0.4 } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("room-lights"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-button-solid"));
    });
    expect(changeMode).toHaveBeenCalledWith({ kind: "solid", targets: ["hue"] });
  });

  it("marks the lights as lit only while a mode runs, and opens on the power button while off", async () => {
    await renderLights({ kind: "off" });
    const trigger = screen.getByTestId("room-lights");
    expect(trigger.querySelector("[data-lit]")).toBeNull();
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(document.activeElement).toBe(screen.getByTestId("mode-button-off"));
  });

  // The label swapped in place keeps the button one width, so the open popover's notch stays on it.
  it("holds every mode's label in the button and shows the running one", async () => {
    await renderLights({ kind: "solid", solid: { r: 255, g: 255, b: 255, brightness: 1 } });
    const shown = screen.getByTestId("room-lights").querySelectorAll("[data-shown]");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toHaveTextContent("common:mode.options.solid");
    expect(shown[0]?.parentElement?.children).toHaveLength(4);
  });

  it("draws nothing outside the lighting provider", () => {
    const { container } = render(<RoomLights />);
    expect(container).toBeEmptyDOMElement();
  });
});
