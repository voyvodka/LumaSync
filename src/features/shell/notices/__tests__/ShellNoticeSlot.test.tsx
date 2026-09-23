import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";

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
      <ShellNoticeSlot variant={variant} queue={queue} suppressed={suppressed} holdSpace={holdSpace} statusBarHeightPx={22} />
      <ShellNoticeAnnouncer queue={queue} />
    </>
  );
}

const cards = () => document.querySelectorAll(".lm-notice");

describe("ShellNoticeSlot", () => {
  it("shows one notice and a count of the rest, expanding them in place", async () => {
    render(<Harness input={THREE} variant="compact" />);

    expect(cards()).toHaveLength(1);
    expect(screen.getByTestId("capture-start-failed-notice")).toHaveClass("is-headline");
    const toggle = screen.getByTestId("notice-toggle");
    expect(toggle).toHaveTextContent("shell:notices.moreBadge:2");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-label", "shell:notices.showMore:2");

    await userEvent.click(toggle);

    expect(cards()).toHaveLength(3);
    expect(screen.getByTestId("notice-toggle")).toHaveAttribute("aria-expanded", "true");
    // Expanded, the top card shows its body as well.
    expect(screen.getByTestId("capture-start-failed-notice")).toHaveClass("is-detail");
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
  it("stacks full-mode cards in one flex column, with no card positioned on its own", async () => {
    render(<Harness input={THREE} variant="full" />);
    await userEvent.click(screen.getByRole("button", { name: "shell:notices.moreCount:2" }));

    const stack = screen.getByTestId("shell-notice-slot");
    expect(stack).toHaveClass("lm-notice-stack");
    expect(stack.style.bottom).toBe("30px");
    expect(cards()).toHaveLength(3);
    for (const card of cards()) {
      expect(card.parentElement).toBe(stack);
      expect(card.getAttribute("style")).toBeNull();
    }
  });

  it("speaks through one persistent live region, and no card is a live region", () => {
    render(<Harness input={THREE} variant="compact" />);

    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(screen.getByTestId("shell-notice-announcer"));
    expect(live[0]).toHaveTextContent("shell:notices.severity.error: shell:notices.titles.capturePermission.");
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

  // The toasts rendered above UpdateModal and outside its focus trap.
  it("sits inert under a modal and says nothing while it is open", () => {
    render(<Harness input={THREE} variant="compact" suppressed />);

    const slot = screen.getByTestId("shell-notice-slot");
    expect(slot).toHaveAttribute("inert");
    expect(screen.getByTestId("shell-notice-announcer")).toBeEmptyDOMElement();
  });

  it("keeps its height while another notice is still due, instead of collapsing and re-opening", () => {
    const { rerender } = render(<Harness input={{ availability: "checking" }} variant="compact" holdSpace />);
    expect(screen.getByTestId("output-checking")).toBeInTheDocument();

    rerender(<Harness input={{ availability: "ready" }} variant="compact" holdSpace />);
    expect(screen.getByTestId("notice-placeholder")).toBeInTheDocument();

    rerender(<Harness input={{ availability: "ready" }} variant="compact" holdSpace={false} />);
    expect(screen.queryByTestId("shell-notice-slot")).toBeNull();
  });

  it("renders nothing, and reserves nothing, for a user with nothing to be told", () => {
    render(<Harness input={{}} variant="compact" holdSpace />);
    expect(screen.queryByTestId("shell-notice-slot")).toBeNull();
  });
});
