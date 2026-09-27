// The CI UI probe reported the manual bridge IP field with no accessible name,
// and the entertainment-area list said which area was chosen, and which one
// another app holds, only in CSS classes. Real page; props static.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

import { bridge, hueState, noBridge, renderPage } from "./hueFixture";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; name?: string }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : opts?.name !== undefined ? `${key}:${opts.name}` : key,
  }),
}));

// Stubbed so nothing here can reach the Tauri transport.
vi.mock("@/features/mode/modeApi", () => ({}));
vi.mock("@/features/hue/ui/HueChannels", () => ({ HueChannels: () => null }));

const areaGroups = [
  {
    roomName: "Living room",
    areas: [
      { id: "free", name: "TV Area", channelCount: 3, activeStreamer: false },
      { id: "held", name: "Desk", channelCount: 2, activeStreamer: true },
    ],
  },
] as unknown as UseHueOnboardingResult["areaGroups"];

const choosing = { areaGroups, selectedAreaId: null, selectedArea: null };

describe("manual bridge IP field", () => {
  it("has a name, and its hint behind the row's ⓘ", () => {
    renderPage(hueState(noBridge));
    const field = screen.getByRole("textbox", { name: "hue:manualIp.inputLabel" });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("button", { name: "common:hintFor" })).toBeInTheDocument();
  });

  it("is marked invalid and described by the error while one is shown", () => {
    renderPage(hueState({ ...noBridge, manualIp: "300.1", manualIpError: "hue:manualIp.invalid" }));
    const field = screen.getByRole("textbox", { name: "hue:manualIp.inputLabel" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("hue:manualIp.invalid");
  });
});

describe("entertainment-area list", () => {
  it("opens from the area row as a named list, with each area's choice state in ARIA", () => {
    renderPage(hueState(choosing));
    const choose = screen.getByRole("button", { name: "hue:page.chooseArea" });
    expect(choose).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(choose);
    expect(choose).toHaveAttribute("aria-expanded", "true");

    const list = screen.getByRole("listbox", { name: "hue:areas.selectLabel" });
    const free = within(list).getByRole("option", { name: /TV Area/ });
    const held = within(list).getByRole("option", { name: /Desk/ });

    expect(free).toHaveAttribute("aria-selected", "false");
    expect(free).not.toHaveAttribute("aria-disabled");
    expect(free).toHaveTextContent("hue:areas.channels:3");

    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(held).toHaveTextContent("hue:areas.activeStreamer");
  });

  it("ignores an area another app holds and takes a free one as the choice", async () => {
    const selectArea = vi.fn<UseHueOnboardingResult["selectArea"]>();
    renderPage(hueState({ ...choosing, selectArea }));
    fireEvent.click(screen.getByRole("button", { name: "hue:page.chooseArea" }));

    fireEvent.click(screen.getByRole("option", { name: /Desk/ }));
    fireEvent.click(screen.getByRole("option", { name: /TV Area/ }));

    await waitFor(() => expect(selectArea).toHaveBeenCalledWith("free"));
    expect(selectArea).toHaveBeenCalledTimes(1);
  });
});

// The found bridge used to be a `role="button"` card holding the "+ Pair"
// button, and the two did different things: the card selected the bridge
// unpaired, which read as expired credentials.
describe("found bridges", () => {
  const found = { ...noBridge, bridges: [bridge, { id: "bridge-2", ip: "192.168.1.11", name: "Office" }] };

  it("are rows with Pair as their only control, named for their bridge", () => {
    renderPage(hueState(found));
    const rows = screen.getAllByTestId("hue-found-bridge");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "hue:page.pairNamed:Test Bridge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "hue:page.pairNamed:Office" })).toBeInTheDocument();
  });

  it("pair the bridge whose row was pressed", () => {
    const pair = vi.fn<UseHueOnboardingResult["pair"]>(async () => {});
    renderPage(hueState({ ...found, pair }));
    fireEvent.click(screen.getByRole("button", { name: "hue:page.pairNamed:Office" }));
    expect(pair).toHaveBeenCalledWith("bridge-2");
  });
});

describe("state word", () => {
  // The drawn word passes over when the state changes, so it is not the live region: one that is
  // mounted with its text is not read out. A stable one beside it is.
  it("is read out from one live region, and the drawn word and its dot are not read twice", () => {
    renderPage(hueState({ ...noBridge, isDiscovering: true }));
    const live = screen.getByTestId("hue-state");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveTextContent("hue:state.searching");
    const drawn = document.querySelector("[data-tone]");
    expect(drawn).toHaveAttribute("aria-hidden", "true");
    expect(drawn).toHaveTextContent("hue:state.searching");
  });
});
