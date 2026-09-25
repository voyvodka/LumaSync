import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import { HUE_LEFT_OUT_REASON } from "@/shared/contracts/lighting";

import { buildShellNotices, type ShellNoticeInput } from "../buildShellNotices";
import { ShellNoticeAnnouncer, ShellNoticeSlot } from "../ShellNoticeSlot";
import { useShellNoticeQueue } from "../useShellNoticeQueue";
import { keyT, makeHandlers, QUIET_INPUT } from "./noticeFixtures";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

// The worst compact case from the redesign: a condition, a Hue warning and
// an unplug at once, which used to be three toasts on top of each other.
const THREE: Partial<ShellNoticeInput> = {
  startFailure: { bucket: CAPTURE_FAILURE_BUCKET.PERMISSION, reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED" },
  hueLeftOut: HUE_LEFT_OUT_REASON.BUSY,
  usbDisconnected: true,
};

interface HarnessProps {
  input: Partial<ShellNoticeInput>;
  variant: "compact" | "full";
  suppressed?: boolean;
  holdSpace?: boolean;
}

function Harness({ input, variant, suppressed = false, holdSpace = false }: HarnessProps) {
  const handlers = useMemo(makeHandlers, []);
  const candidates = useMemo(
    () => buildShellNotices({ ...QUIET_INPUT, uiMode: variant, ...input }, handlers, keyT),
    [input, variant, handlers],
  );
  const queue = useShellNoticeQueue(candidates, { suppressed });
  return (
    <>
      <ShellNoticeSlot variant={variant} queue={queue} suppressed={suppressed} holdSpace={holdSpace} />
      <ShellNoticeAnnouncer queue={queue} />
    </>
  );
}

const rows = () => document.querySelectorAll(".lm-notice");

/** happy-dom has no layout: pretend every message line is cut. */
function stubCutLines() {
  const width = (cut: number) =>
    function (this: HTMLElement) {
      return this.classList.contains("lm-notice-message") ? cut : 0;
    };
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(width(400));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(width(180));
}

describe("ShellNoticeSlot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows one notice and a count of the rest, expanding them in place", async () => {
    render(<Harness input={THREE} variant="compact" />);

    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("capture-start-failed-notice")).not.toHaveClass("is-wrapped");
    const toggle = screen.getByTestId("notice-toggle");
    expect(toggle).toHaveTextContent("shell:notices.moreBadge:2");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-label", "shell:notices.showMore:2");

    await userEvent.click(toggle);

    expect(rows()).toHaveLength(3);
    expect(screen.getByTestId("notice-toggle")).toHaveAttribute("aria-expanded", "true");
    // Expanded, every line wraps, so no sentence is cut.
    for (const row of rows()) expect(row).toHaveClass("is-wrapped");
    expect(screen.getByTestId("hue-left-out-notice")).toBeInTheDocument();
    expect(screen.getByTestId("usb-disconnect-notice")).toBeInTheDocument();
  });

  it("puts the slot in flow at the top of the compact body, never over it", () => {
    render(<Harness input={THREE} variant="compact" />);
    const slot = screen.getByTestId("shell-notice-slot");

    expect(slot).toHaveClass("lm-notice-slot");
    expect(slot.getAttribute("style")).toBeNull();
  });

  // The toasts were each `position: fixed` with a guessed 3.5rem offset per
  // slot; real heights were 74–90 px, so they overlapped.
  // A floating bottom-right stack covered the page under a condition that
  // could last all session; full now sits in flow above the content too.
  it("puts the full slot in flow above the content, one line and a '+N'", async () => {
    render(<Harness input={THREE} variant="full" />);

    const slot = screen.getByTestId("shell-notice-slot");
    expect(slot).toHaveClass("lm-notice-slot", "is-wide");
    expect(slot.getAttribute("style")).toBeNull();
    expect(rows()).toHaveLength(1);
    const top = screen.getByTestId("capture-start-failed-notice");
    expect(top).toHaveTextContent("shell:notices.messages.capturePermission");

    await userEvent.click(screen.getByRole("button", { name: "shell:notices.showMore:2" }));

    expect(rows()).toHaveLength(3);
    for (const card of rows()) {
      expect(card.parentElement).toBe(slot);
      expect(card.getAttribute("style")).toBeNull();
    }
  });

  // The full-mode banner had "Open devices" beside "Check again"; the queue
  // keeps both where there is room, and the compact line keeps one.
  it("shows the second action on the full line and the expanded strip, never on the compact line", async () => {
    stubCutLines();
    const gaveUp: Partial<ShellNoticeInput> = { availability: "none", hueProbeGaveUp: true };
    const { unmount } = render(<Harness input={gaveUp} variant="full" />);
    const row = screen.getByTestId("output-none-notice");
    expect(within(row).getByRole("button", { name: "shell:notices.actions.checkAgain" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "shell:notices.actions.devices" })).toHaveClass("is-secondary");
    unmount();

    render(<Harness input={gaveUp} variant="compact" />);
    const line = screen.getByTestId("output-none-notice");
    expect(within(line).getByRole("button", { name: "shell:notices.actions.checkAgain" })).toBeInTheDocument();
    expect(within(line).queryByRole("button", { name: "shell:notices.actions.devices" })).toBeNull();

    await userEvent.click(screen.getByTestId("notice-toggle"));
    expect(
      within(screen.getByTestId("output-none-notice")).getByRole("button", { name: "shell:notices.actions.devices" }),
    ).toBeInTheDocument();
  });

  // Compact cuts the sentence with an ellipsis; the rest must still be
  // reachable — by hover, and without a pointer.
  it("offers a cut sentence as a tooltip and behind its own toggle", async () => {
    stubCutLines();
    render(<Harness input={{ availability: "none" }} variant="compact" />);

    const message = screen.getByText("shell:notices.messages.outputNone");
    expect(message).toHaveAttribute("title", "shell:notices.messages.outputNone");
    const toggle = screen.getByTestId("notice-toggle");
    expect(toggle).toHaveAttribute("aria-label", "shell:notices.showDetails");

    await userEvent.click(toggle);

    expect(screen.getByTestId("output-none-notice")).toHaveClass("is-wrapped");
    expect(message).not.toHaveAttribute("title");
    // Wrapped, the line no longer overflows; the toggle stays to fold it back.
    expect(screen.getByTestId("notice-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("notice-toggle")).toHaveAttribute("aria-label", "shell:notices.showLess");
  });

  it("offers no toggle, and no tooltip, for a lone sentence that fits", () => {
    render(<Harness input={{ availability: "none" }} variant="compact" />);

    expect(screen.queryByTestId("notice-toggle")).toBeNull();
    expect(screen.getByText("shell:notices.messages.outputNone")).not.toHaveAttribute("title");
  });

  // The arrow marks a link to another screen; a screen reader hears the label alone.
  it("marks an action that opens another screen with an arrow the accessible name leaves out", () => {
    render(<Harness input={{ availability: "none" }} variant="full" />);

    const devices = screen.getByRole("button", { name: "shell:notices.actions.devices" });
    const arrow = devices.querySelector(".lm-notice-arrow");
    expect(arrow).toHaveAttribute("aria-hidden", "true");
  });

  it("speaks through one persistent live region, and no card is a live region", () => {
    render(<Harness input={THREE} variant="compact" />);

    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(screen.getByTestId("shell-notice-announcer"));
    expect(live[0]).toHaveTextContent("shell:notices.severity.error: shell:notices.messages.capturePermission");
    expect(within(screen.getByTestId("shell-notice-slot")).queryByRole("status")).toBeNull();
  });

  it("offers a 32 px dismiss on events and none on conditions", async () => {
    const { rerender } = render(<Harness input={{ usbDisconnected: true }} variant="compact" />);
    expect(screen.getByTestId("notice-dismiss")).toHaveAttribute("aria-label", "shell:notices.dismiss");
    await userEvent.click(screen.getByTestId("notice-dismiss"));
    expect(screen.queryByTestId("usb-disconnect-notice")).toBeNull();

    rerender(<Harness input={{ hueLeftOut: HUE_LEFT_OUT_REASON.BUSY }} variant="compact" />);
    expect(screen.getByTestId("hue-left-out-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("notice-dismiss")).toBeNull();
  });

  // The guide's × read "Dismiss notice" and ended the guide for good.
  it("names the guide's dismiss as skipping it: a text button in full, the ×'s name in compact", async () => {
    const guide: Partial<ShellNoticeInput> = { onboardingStep: "devices" };
    const { unmount } = render(<Harness input={guide} variant="full" />);
    const skip = screen.getByRole("button", { name: "shell:notices.skipSetupGuide" });
    expect(skip).toHaveTextContent("shell:notices.skipSetupGuide");
    unmount();

    render(<Harness input={guide} variant="compact" />);
    const close = screen.getByTestId("notice-dismiss");
    expect(close).toHaveAttribute("aria-label", "shell:notices.skipSetupGuide");
    expect(close).toHaveAttribute("title", "shell:notices.skipSetupGuide");
    await userEvent.click(close);
    expect(screen.queryByTestId("onboarding-notice")).toBeNull();
  });

  // The toasts rendered above UpdateModal and outside its focus trap.
  it("sits inert under a modal and says nothing while it is open", () => {
    render(<Harness input={THREE} variant="compact" suppressed />);

    const slot = screen.getByTestId("shell-notice-slot");
    expect(slot).toHaveAttribute("inert");
    expect(screen.getByTestId("shell-notice-announcer")).toBeEmptyDOMElement();
  });

  it.each(["compact", "full"] as const)(
    "keeps its height while another notice is still due, instead of collapsing and re-opening (%s)",
    (variant) => {
      const { rerender } = render(<Harness input={{ availability: "checking" }} variant={variant} holdSpace />);
      expect(screen.getByTestId("output-checking")).toBeInTheDocument();

      rerender(<Harness input={{ availability: "ready" }} variant={variant} holdSpace />);
      expect(screen.getByTestId("notice-placeholder")).toBeInTheDocument();

      rerender(<Harness input={{ availability: "ready" }} variant={variant} holdSpace={false} />);
      expect(screen.queryByTestId("shell-notice-slot")).toBeNull();
    },
  );

  it("renders nothing, and reserves nothing, for a user with nothing to be told", () => {
    render(<Harness input={{}} variant="compact" holdSpace />);
    expect(screen.queryByTestId("shell-notice-slot")).toBeNull();
  });
});
