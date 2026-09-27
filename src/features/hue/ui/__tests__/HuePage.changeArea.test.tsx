// "Change area" only re-read the list: `refreshAreas` keeps the saved area, and
// the list opened only while no area was set, so a bridge with an area never
// showed it again and the area could not be changed from the card. The list now
// floats from the area row, and picking an area is the choice.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

import { HuePage } from "../HuePage";
import { hueState, renderPage, shownByTestId } from "./hueFixture";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

// Stubbed so nothing here can reach the Tauri transport.
vi.mock("@/features/mode/modeApi", () => ({}));
vi.mock("@/features/settings/sections/HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const areaGroups = [
  {
    roomName: "Living room",
    areas: [
      { id: "tv", name: "TV Area", channelCount: 3, activeStreamer: false },
      { id: "desk", name: "Desk", channelCount: 2, activeStreamer: false },
    ],
  },
] as unknown as UseHueOnboardingResult["areaGroups"];
const [tvArea, deskArea] = areaGroups[0]?.areas ?? [];

const withAreas = (overrides: Partial<UseHueOnboardingResult> = {}) =>
  hueState({ areaGroups, selectedAreaId: "tv", selectedArea: tvArea ?? null, ...overrides });

const page = (hue: UseHueOnboardingResult) => (
  <HuePage
    isActive
    hue={hue}
    channelPlacements={[]}
    onPositionChange={async () => {}}
    persistError={false}
    zones={[]}
    onStopHue={async () => {}}
  />
);

const areaList = () => screen.queryByRole("listbox", { name: "hue:areas.selectLabel" });
const changeButton = () => screen.getByRole("button", { name: "hue:page.changeArea" });

describe("HuePage — Change area", () => {
  it("shows the area in use as the row's value", () => {
    renderPage(withAreas());
    expect(screen.getByTestId("hue-area-row")).toHaveTextContent("TV Area · hue:areas.channels:3");
  });

  it("opens the list with the area in use marked and focused, and re-reads the bridge's areas", () => {
    const refreshAreas = vi.fn<UseHueOnboardingResult["refreshAreas"]>(async () => {});
    renderPage(withAreas({ refreshAreas }));
    expect(areaList()).toBeNull();

    fireEvent.click(changeButton());

    const current = within(areaList() as HTMLElement).getByRole("option", { name: /TV Area/ });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveFocus();
    expect(refreshAreas).toHaveBeenCalledOnce();
  });

  it("keeps the old area on Esc and hands focus back to Change", () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    renderPage(withAreas({ selectArea }));
    fireEvent.click(changeButton());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(areaList()).toBeNull();
    expect(selectArea).not.toHaveBeenCalled();
    expect(changeButton()).toHaveFocus();
  });

  it("switches on a pick, then checks the new area once it is the selection", async () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    const revalidateArea = vi.fn<UseHueOnboardingResult["revalidateArea"]>(async () => {});
    const { rerender } = renderPage(withAreas({ selectArea, revalidateArea }));
    fireEvent.click(changeButton());

    fireEvent.click(screen.getByRole("option", { name: /Desk/ }));

    await waitFor(() => expect(selectArea).toHaveBeenCalledWith("desk"));
    expect(areaList()).toBeNull();
    expect(changeButton()).toHaveFocus();
    // Run before the hook carries the new area, the check would read the old one.
    expect(revalidateArea).not.toHaveBeenCalled();
    act(() => {
      rerender(page(withAreas({ selectArea, revalidateArea, selectedAreaId: "desk", selectedArea: deskArea ?? null })));
    });
    expect(revalidateArea).toHaveBeenCalledOnce();
  });

  it("closes without a switch when the area in use is picked", async () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    renderPage(withAreas({ selectArea }));
    fireEvent.click(changeButton());

    fireEvent.click(screen.getByRole("option", { name: /TV Area/ }));

    await waitFor(() => expect(areaList()).toBeNull());
    expect(selectArea).not.toHaveBeenCalled();
  });

  it("drops the list when the page leaves a state that offers it", () => {
    const { rerender } = renderPage(withAreas());
    fireEvent.click(changeButton());
    expect(areaList()).not.toBeNull();

    rerender(page(withAreas({ bridgeUnreachable: true })));
    expect(areaList()).toBeNull();
    rerender(page(withAreas()));
    expect(areaList()).toBeNull();
  });

  it("makes choosing the area the one amber action while none is chosen", () => {
    renderPage(withAreas({ selectedAreaId: null, selectedArea: null }));
    const choose = screen.getByRole("button", { name: "hue:page.chooseArea" });
    expect(choose.className).toMatch(/primary/);
    expect(screen.getByTestId("hue-area-row")).toHaveTextContent("hue:page.noArea");
  });
});

describe("HuePage — an area the state only shows", () => {
  // Reconnecting has not read the list; "no areas found" would be a guess.
  it("has no row, and says nothing of areas, when none is chosen", () => {
    renderPage(
      hueState({
        selectedAreaId: null,
        selectedArea: null,
        runtimeStatus: { state: "Reconnecting", code: "TRANSIENT_RETRY_SCHEDULED", message: "", details: null, triggerSource: "system" },
      }),
    );
    expect(shownByTestId("hue-area-row")).toBeNull();
    expect(screen.queryByText("hue:areas.empty")).toBeNull();
  });

  it("shows the area without a way to change it", () => {
    renderPage(
      withAreas({
        runtimeStatus: { state: "Reconnecting", code: "TRANSIENT_RETRY_SCHEDULED", message: "", details: null, triggerSource: "system" },
      }),
    );
    expect(screen.getByTestId("hue-area-row")).toHaveTextContent("TV Area");
    expect(screen.queryByRole("button", { name: "hue:page.changeArea" })).toBeNull();
  });
});
