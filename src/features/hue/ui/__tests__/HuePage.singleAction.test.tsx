// Stale and gate-blocked cards showed Validate twice — once inside the alert,
// once in the footer — and an offline bridge showed Rediscover in the page
// header and the footer. A state's actions live only on the bridge row; the
// note carries the message and, at most, a code behind ⓘ. Real page; props static.

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

import { hueState, onboarding, renderPage, runtime } from "./hueFixture";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Stubbed so nothing here can reach the Tauri transport.
vi.mock("@/features/mode/modeApi", () => ({}));
vi.mock("@/features/settings/sections/HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const renderCard = (hue: UseHueOnboardingResult) => renderPage(hue);

function expectOneRowValidate(noteTestId: string, revalidateArea: () => Promise<void>) {
  const validate = screen.getAllByRole("button", { name: "hue:page.validate" });
  expect(validate).toHaveLength(1);
  expect(validate[0].className).toMatch(/primary/);
  expect(screen.getByTestId("hue-bridge-row")).toContainElement(validate[0]);
  expect(within(screen.getByTestId(noteTestId)).queryByRole("button", { name: "hue:page.validate" })).toBeNull();

  fireEvent.click(validate[0]);
  expect(revalidateArea).toHaveBeenCalledTimes(1);
}

describe("HuePage — one Validate control", () => {
  it("stale readiness keeps the message in the note and Validate on the row", () => {
    const revalidateArea = vi.fn(async () => {});
    renderCard(hueState({ isReadinessStale: true, revalidateArea }));
    expect(screen.getByTestId("hue-stale")).toHaveTextContent("hue:runtime.checklist.revalidate");
    expectOneRowValidate("hue-stale", revalidateArea);
  });

  it("a blocked gate keeps its reasons and code in the note and Validate on the row", () => {
    const revalidateArea = vi.fn(async () => {});
    renderCard(
      hueState({
        isReadinessStale: true,
        runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED"),
        revalidateArea,
      }),
    );
    const note = screen.getByTestId("hue-gate-blocked");
    expect(note).toHaveTextContent("hue:runtime.checklist.revalidate");
    fireEvent.click(within(note).getByRole("button", { name: "hue:page.codeTip" }));
    expect(screen.getByTestId("hue-fault-code")).toHaveTextContent("CONFIG_NOT_READY_GATE_BLOCKED");
    expectOneRowValidate("hue-gate-blocked", revalidateArea);
  });

  it("the busy label stays on the single control while a check runs", () => {
    renderCard(hueState({ isReadinessStale: true, isCheckingReadiness: true }));
    const busy = screen.getAllByRole("button", { name: "hue:actions.checkingReadiness" });
    expect(busy).toHaveLength(1);
    expect(busy[0]).toHaveAttribute("aria-busy", "true");
  });
});

const CARD_STATES: Array<{ name: string; hue: UseHueOnboardingResult }> = [
  { name: "streaming", hue: hueState({ runtimeStatus: runtime("Running", "HUE_STREAM_RUNNING") }) },
  { name: "idle", hue: hueState() },
  {
    name: "statusUnknown",
    hue: hueState({ runtimeStatusReadFailure: { code: "HUE_STREAM_STATUS_UNAVAILABLE", message: "x", details: null } }),
  },
  { name: "stale", hue: hueState({ isReadinessStale: true }) },
  { name: "gateBlocked", hue: hueState({ runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED") }) },
  { name: "stopPartial", hue: hueState({ runtimeStatus: runtime("Failed", "HUE_STOP_TIMEOUT_PARTIAL") }) },
  { name: "streamFailed", hue: hueState({ runtimeStatus: runtime("Failed", "TRANSIENT_RETRY_EXHAUSTED") }) },
  { name: "reconnecting", hue: hueState({ runtimeStatus: runtime("Reconnecting", "TRANSIENT_RETRY_SCHEDULED") }) },
  { name: "offline", hue: hueState({ bridgeUnreachable: true }) },
  {
    name: "authError",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("AUTH_INVALID_RE_PAIR_REQUIRED") }),
  },
  { name: "pairingFailed", hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_FAILED") }) },
  {
    name: "pairingTimedOut",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_LINK_BUTTON_NOT_PRESSED") }),
  },
  {
    name: "pairingDeferred",
    hue: hueState({ credentialState: "needs_repair", status: onboarding("HUE_PAIRING_BRIDGE_BUSY") }),
  },
  { name: "pairing", hue: hueState({ credentialState: "needs_repair", isPairing: true }) },
  {
    name: "pairingLinkButton",
    hue: hueState({ credentialState: "needs_repair", isPairing: true, status: onboarding("HUE_PAIRING_PENDING_LINK_BUTTON") }),
  },
  { name: "areaSelect", hue: hueState({ selectedAreaId: null, selectedArea: null }) },
];

describe("HuePage — no card state offers an action twice", () => {
  it.each(CARD_STATES)("$name", ({ hue }) => {
    renderCard(hue);
    const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size, `duplicate controls: ${names.join(" | ")}`).toBe(names.length);
  });
});
