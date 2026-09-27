// A revoked app key showed two Re-pair buttons (one in the alert, one in the
// footer) and the raw AUTH_INVALID_RE_PAIR_REQUIRED as the large headline of
// a stat cell. Every state now keeps its actions on the bridge row and a raw
// code behind the ⓘ at the end of its note. Real page; props are static.

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

/** The code is behind the note's ⓘ, never the state word or the note's text. */
function expectCodeAsDetail(code: string, noteTestId?: string): HTMLElement {
  expect(screen.getByTestId("hue-state")).not.toHaveTextContent(code);
  const tip = screen.getByRole("button", { name: "hue:page.codeTip" });
  if (noteTestId) expect(screen.getByTestId(noteTestId)).toContainElement(tip);
  expect(screen.queryByTestId("hue-fault-code")).toBeNull();
  fireEvent.click(tip);
  const detail = screen.getByTestId("hue-fault-code");
  expect(detail).toHaveTextContent(`hue:card.codeLabel ${code}`);
  expect(within(detail).getByText(code).tagName).toBe("CODE");
  return detail;
}

describe("HuePage — revoked app key", () => {
  const revoked = () =>
    hueState({
      credentialState: "needs_repair",
      status: onboarding("AUTH_INVALID_RE_PAIR_REQUIRED"),
    });

  it("offers exactly one Re-pair control, on the bridge row as its amber action, and it pairs", () => {
    const pair = vi.fn(async () => {});
    renderCard({ ...revoked(), pair });

    const repair = screen.getAllByRole("button", { name: "hue:runtime.actions.repair" });
    expect(repair).toHaveLength(1);
    expect(repair[0].className).toMatch(/primary/);
    expect(screen.getByTestId("hue-bridge-row")).toContainElement(repair[0]);
    expect(
      within(screen.getByTestId("hue-auth-error")).queryByRole("button", { name: "hue:runtime.actions.repair" }),
    ).toBeNull();

    fireEvent.click(repair[0]);
    expect(pair).toHaveBeenCalledTimes(1);
  });

  it("offers one Re-pair control on a failed pairing too", () => {
    renderCard(
      hueState({
        credentialState: "needs_repair",
        status: onboarding("HUE_PAIRING_FAILED"),
      }),
    );
    expect(screen.getAllByRole("button", { name: "hue:runtime.actions.repair" })).toHaveLength(1);
  });

  it("says the key was refused in a word, and keeps the raw code behind the note's ⓘ", () => {
    renderCard(revoked());
    const note = screen.getByTestId("hue-auth-error");
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent("hue:credential.repairHint");
    expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.authError");
    expectCodeAsDetail("AUTH_INVALID_RE_PAIR_REQUIRED", "hue-auth-error");
  });

  it("never captions the fault with the success code the last onboarding call returned (H-12)", () => {
    renderCard(hueState({ credentialState: "needs_repair", status: onboarding("HUE_DISCOVERY_OK") }));
    expect(screen.getByTestId("hue-auth-error")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-fault-code")).toBeNull();
    expect(screen.queryByText("HUE_DISCOVERY_OK")).toBeNull();
  });
});

describe("HuePage — raw codes are a detail in every state that shows one", () => {
  const cases: Array<{ name: string; hue: UseHueOnboardingResult; code: string; container?: string }> = [
    {
      name: "streamFailed",
      hue: hueState({ runtimeStatus: runtime("Failed", "TRANSIENT_RETRY_EXHAUSTED", { actionHint: "retry" }) }),
      code: "TRANSIENT_RETRY_EXHAUSTED",
      container: "hue-stream-failed",
    },
    {
      name: "statusUnknown",
      hue: hueState({
        runtimeStatusReadFailure: { code: "HUE_STREAM_STATUS_UNAVAILABLE", message: "IPC closed", details: null },
      }),
      code: "HUE_STREAM_STATUS_UNAVAILABLE",
      container: "hue-status-unavailable",
    },
    {
      name: "reconnecting",
      hue: hueState({
        status: onboarding("HUE_STREAM_RECOVERY_FAILED"),
        runtimeStatus: runtime("Reconnecting", "TRANSIENT_RETRY_SCHEDULED", { remainingAttempts: 3, nextAttemptMs: 2000 }),
      }),
      // The runtime is what is reconnecting; the last onboarding answer is not its reason (H-12).
      code: "TRANSIENT_RETRY_SCHEDULED",
    },
    {
      name: "stopPartial",
      hue: hueState({ runtimeStatus: runtime("Failed", "HUE_STOP_TIMEOUT_PARTIAL") }),
      code: "HUE_STOP_TIMEOUT_PARTIAL",
    },
    {
      name: "gateBlocked",
      hue: hueState({ runtimeStatus: runtime("Idle", "CONFIG_NOT_READY_GATE_BLOCKED") }),
      code: "CONFIG_NOT_READY_GATE_BLOCKED",
    },
  ];

  it.each(cases)("$name", ({ hue, code, container: testId }) => {
    renderCard(hue);
    expectCodeAsDetail(code, testId);
  });

  it("keeps Re-pair single on a stream the runtime says was refused", () => {
    renderCard(hueState({ runtimeStatus: runtime("Failed", "AUTH_INVALID_CREDENTIALS", { actionHint: "repair" }) }));
    expect(screen.getAllByRole("button", { name: "hue:runtime.actions.repair" })).toHaveLength(1);
    expectCodeAsDetail("AUTH_INVALID_CREDENTIALS", "hue-stream-failed");
  });

  it("shows no code on a healthy bridge", () => {
    renderCard(hueState({ runtimeStatus: runtime("Idle", "HUE_STREAM_IDLE") }));
    expect(screen.getByTestId("hue-state")).toHaveTextContent("hue:state.idle");
    expect(screen.queryByRole("button", { name: "hue:page.codeTip" })).toBeNull();
  });
});
