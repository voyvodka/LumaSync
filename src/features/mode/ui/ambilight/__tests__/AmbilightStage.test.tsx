import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AmbilightPayload } from "@/shared/contracts/mode";

const setPreference = vi.hoisted(() => vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}));
vi.mock("@/features/persistence/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/persistence/preferences")>()),
  setPreference,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { __resetPreferencesForTests, __setPreferenceForTests } from "@/features/persistence/preferences";
import { AmbilightStage } from "../AmbilightStage";

const ambilight: AmbilightPayload = { brightness: 0.8, saturation: 1.2, blackBorderDetection: false };

function renderStage(props: Partial<Parameters<typeof AmbilightStage>[0]> = {}) {
  const onChange = vi.fn<(next: AmbilightPayload) => void>();
  render(<AmbilightStage ambilight={ambilight} onChange={onChange} {...props} />);
  return onChange;
}

beforeEach(() => {
  setPreference.mockClear();
  __resetPreferencesForTests();
  __setPreferenceForTests("lightingIntensityPreset", "intense");
});

describe("AmbilightStage", () => {
  // Read at boot: the stage opens on the stored choice, not a default that slides over.
  it("opens on the stored values and the stored smoothing", () => {
    renderStage();
    expect(screen.getByTestId("ambilight-brightness")).toHaveValue("80");
    expect(screen.getByTestId("ambilight-saturation")).toHaveValue("120");
    expect(screen.getByTestId("smoothing-intense")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ambilight-black-border")).not.toBeChecked();
  });

  it("sends brightness and saturation as fractions, keeping the rest", () => {
    const onChange = renderStage();
    fireEvent.change(screen.getByTestId("ambilight-brightness"), { target: { value: "40" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...ambilight, brightness: 0.4 });
    fireEvent.change(screen.getByTestId("ambilight-saturation"), { target: { value: "150" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...ambilight, saturation: 1.5 });
  });

  it("stores a smoothing choice as the preference, and the black-bar switch on the payload", () => {
    const onChange = renderStage();
    fireEvent.click(screen.getByTestId("smoothing-subtle"));
    expect(setPreference).toHaveBeenCalledWith("lightingIntensityPreset", "subtle");
    fireEvent.click(screen.getByTestId("ambilight-black-border"));
    expect(onChange).toHaveBeenLastCalledWith({ ...ambilight, blackBorderDetection: true });
  });

  it("compact keeps brightness and smoothing only", () => {
    renderStage({ dense: true });
    expect(screen.getByTestId("ambilight-brightness")).toBeInTheDocument();
    expect(screen.getByTestId("smoothing-moderate")).toBeInTheDocument();
    expect(screen.queryByTestId("ambilight-saturation")).toBeNull();
    expect(screen.queryByTestId("ambilight-black-border")).toBeNull();
  });

  it("locks brightness with its reason where the firmware carries none, and says what holds the link back", () => {
    renderStage({ brightnessLocked: true, brightnessTitle: "Adalight has no brightness", linkNote: "30 fps at most" });
    expect(screen.getByTestId("ambilight-brightness")).toBeDisabled();
    expect(screen.getByTestId("ambilight-brightness")).toHaveAttribute("title", "Adalight has no brightness");
    expect(screen.getByTestId("ambilight-saturation")).toBeEnabled();
    expect(screen.getByText("30 fps at most")).toBeInTheDocument();
  });
});
