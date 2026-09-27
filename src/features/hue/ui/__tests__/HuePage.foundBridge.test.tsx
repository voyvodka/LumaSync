// A bridge the network found is a row of its own on the Devices rail, and its
// page offers to pair it. With one bridge already paired, pairing another
// replaces it (one bridge at a time), so the page says so before it happens.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueBridgeSummary } from "@/features/hue/hueOnboardingApi";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

import { bridge, hueState, noBridge, renderPage, runtime } from "./hueFixture";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name !== undefined ? `${key}:${opts.name}` : key),
  }),
}));

vi.mock("@/features/mode/modeApi", () => ({}));
vi.mock("@/features/settings/sections/HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const office: HueBridgeSummary = { id: "bridge-2", ip: "192.168.1.11", name: "Hue Bridge (192.168.1.11)" };

describe("HuePage — a found bridge", () => {
  it("is named without the address Rust appends, and pairing it is the one amber action", () => {
    const pair = vi.fn<UseHueOnboardingResult["pair"]>(async () => {});
    renderPage(hueState({ ...noBridge, bridges: [office], pair }), { foundBridge: office });

    expect(screen.getByRole("heading", { name: "Hue Bridge" })).toBeInTheDocument();
    expect(screen.getByTestId("hue-bridge-row")).toHaveTextContent("192.168.1.11");
    expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.unpaired");
    const pairButton = screen.getByRole("button", { name: "hue:page.pair" });
    expect(pairButton.className).toMatch(/primary/);
    expect(screen.getByTestId("hue-pair-prompt")).not.toHaveTextContent("hue:page.replaces");

    fireEvent.click(pairButton);
    expect(pair).toHaveBeenCalledExactlyOnceWith("bridge-2");
  });

  it("says which paired bridge it would replace", () => {
    renderPage(hueState({ bridges: [bridge, office] }), { foundBridge: office });
    expect(screen.getByTestId("hue-pair-prompt")).toHaveTextContent("hue:page.replaces:Test Bridge");
  });

  it("shows the bridge's own state once it is the one being paired", () => {
    renderPage(
      hueState({
        bridges: [bridge, office],
        selectedBridgeId: office.id,
        selectedBridge: office,
        credentials: null,
        credentialState: "unknown",
        isPairing: true,
      }),
      { foundBridge: office },
    );
    expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.pairing");
    expect(screen.getByRole("button", { name: "hue:page.cancel" })).toBeInTheDocument();
  });

  // The page could not stop a stream on the bridge it replaces, so it does not start replacing it.
  it("waits for Hue to stop before pairing over a bridge that is running it", () => {
    const pair = vi.fn<UseHueOnboardingResult["pair"]>(async () => {});
    renderPage(hueState({ bridges: [bridge, office], pair, runtimeStatus: runtime("Running", "HUE_STREAM_RUNNING") }), {
      foundBridge: office,
    });
    expect(screen.getByTestId("hue-pair-prompt")).toHaveTextContent("hue:page.stopFirst");
    const pairButton = screen.getByRole("button", { name: "hue:page.pair" });
    expect(pairButton).toBeDisabled();
    fireEvent.click(pairButton);
    expect(pair).not.toHaveBeenCalled();
  });
});
