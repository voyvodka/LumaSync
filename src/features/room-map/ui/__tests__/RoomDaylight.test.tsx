import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetPreferencesForTests, __setPreferenceForTests, getPreference } from "@/features/persistence/preferences";

import { RoomDaylight } from "../RoomDaylight";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { percent?: number; band?: string; value?: string }) =>
      values?.band ? `${key}:${values.percent}:${values.band}` : values?.value ? `${key}:${values.value}` : key,
  }),
}));

const saves = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: Record<string, unknown>) => {
      saves.push(partial);
      return Promise.resolve();
    },
    onSaved: () => () => {},
  },
}));

beforeEach(() => {
  __setPreferenceForTests("roomMapAmbient", 35);
});

afterEach(() => {
  saves.length = 0;
  cleanup();
  __resetPreferencesForTests();
});

const open = () => {
  render(<RoomDaylight />);
  fireEvent.click(screen.getByTestId("room-daylight"));
  return screen.getByLabelText("roomMap:settings.daylightRange");
};

describe("RoomDaylight", () => {
  it("shows the stored value at rest and names it with its band", () => {
    render(<RoomDaylight />);
    const button = screen.getByTestId("room-daylight");
    expect(button.textContent).toBe("35%");
    expect(button.getAttribute("aria-label")).toBe("roomMap:view.daylightControl:roomMap:settings.daylightValueText:35:roomMap:settings.daylightBand.dusk");
    expect(screen.queryByLabelText("roomMap:settings.daylightRange")).toBeNull();
  });

  it("follows the thumb at once, in the button too, and saves only where it is let go", () => {
    const slider = open();
    fireEvent.change(slider, { target: { value: "60" } });
    fireEvent.change(slider, { target: { value: "80" } });
    expect(getPreference("roomMapAmbient")).toBe(80);
    expect(screen.getByTestId("room-daylight").textContent).toBe("80%");
    expect(saves).toEqual([]);
    fireEvent.pointerUp(slider);
    fireEvent.blur(slider);
    expect(saves).toEqual([{ roomMapAmbient: 80 }]);
  });

  it("saves a value another window moved it away from", () => {
    const slider = open();
    act(() => __setPreferenceForTests("roomMapAmbient", 80));
    fireEvent.change(slider, { target: { value: "35" } });
    fireEvent.pointerUp(slider);
    expect(saves).toEqual([{ roomMapAmbient: 35 }]);
  });

  // Esc closed the panel mid-drag, and the room went back to its old light on the next start.
  it("saves the shown value when the popover closes before the thumb is let go", () => {
    fireEvent.change(open(), { target: { value: "10" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();
    expect(saves).toEqual([{ roomMapAmbient: 10 }]);
  });

  it("tells a screen reader the band as well as the percent", () => {
    const slider = open();
    fireEvent.change(slider, { target: { value: "5" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("roomMap:settings.daylightValueText:5:roomMap:settings.daylightBand.night");
    fireEvent.change(slider, { target: { value: "90" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("roomMap:settings.daylightValueText:90:roomMap:settings.daylightBand.day");
  });
});
