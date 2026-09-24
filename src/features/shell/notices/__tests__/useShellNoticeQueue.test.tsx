import { act, renderHook } from "@testing-library/react";
import type { FocusEvent } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  NOTICE_SEVERITY,
  NOTICE_TIER,
  NOTICE_VIEW,
  type NoticeView,
  type ShellNotice,
  type ShellNoticeId,
} from "../noticeModel";
import { NOTICE_MIN_VISIBLE_MS, NOTICE_RELEASE_GRACE_MS, useShellNoticeQueue } from "../useShellNoticeQueue";

function notice(id: ShellNoticeId, overrides: Partial<ShellNotice> = {}): ShellNotice {
  return {
    id,
    tier: NOTICE_TIER.WARNING,
    severity: NOTICE_SEVERITY.WARNING,
    kind: "event",
    message: id,
    dismissible: true,
    source: true,
    testId: id,
    ...overrides,
  };
}

function setup(initial: ShellNotice[], suppressed = false) {
  return renderHook(({ candidates, suppressed }) => useShellNoticeQueue(candidates, { suppressed }), {
    initialProps: { candidates: initial, suppressed },
  });
}

const ids = (entries: { notice: ShellNotice }[]) => entries.map((entry) => entry.notice.id);
const blur = { currentTarget: document.body, relatedTarget: null } as unknown as FocusEvent<HTMLElement>;

describe("useShellNoticeQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the builder's order through and counts what is behind the top", () => {
    const { result } = setup([notice("capture-permission"), notice("usb-disconnected"), notice("onboarding")]);

    expect(ids(result.current.entries)).toEqual(["capture-permission", "usb-disconnected", "onboarding"]);
    expect(result.current.entries.slice(1)).toHaveLength(2);
  });

  // A condition leaves when its state does; the queue has no clock for it.
  it("never expires a condition on its own", () => {
    const { result } = setup([notice("capture-permission", { kind: "condition", dismissible: false })]);

    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(ids(result.current.entries)).toEqual(["capture-permission"]);
  });

  it("lets an event go when its source does, if nobody is reading it", () => {
    const { result, rerender } = setup([notice("usb-disconnected")]);
    rerender({ candidates: [], suppressed: false });
    expect(result.current.entries).toEqual([]);
  });

  describe("holding an event while it is being read", () => {
    it("keeps it while the pointer is on it, then lets it go after a short grace", () => {
      const { result, rerender } = setup([notice("usb-disconnected")]);
      act(() => result.current.holdProps.onPointerEnter());

      rerender({ candidates: [], suppressed: false });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);

      act(() => result.current.holdProps.onPointerLeave());
      act(() => {
        vi.advanceTimersByTime(NOTICE_RELEASE_GRACE_MS - 1);
      });
      expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.entries).toEqual([]);
    });

    it("keeps it while focus is inside", () => {
      const { result, rerender } = setup([notice("stop-failed")]);
      act(() => result.current.holdProps.onFocus());
      rerender({ candidates: [], suppressed: false });
      expect(ids(result.current.entries)).toEqual(["stop-failed"]);

      act(() => result.current.holdProps.onBlur(blur));
      act(() => {
        vi.advanceTimersByTime(NOTICE_RELEASE_GRACE_MS);
      });
      expect(result.current.entries).toEqual([]);
    });

    it("does not keep a condition that cleared under the pointer — it is no longer true", () => {
      const { result, rerender } = setup([notice("capture-stalled", { kind: "condition" })]);
      act(() => result.current.holdProps.onPointerEnter());
      rerender({ candidates: [], suppressed: false });
      expect(result.current.entries).toEqual([]);
    });
  });

  // An unplug during the update prompt used to toast over the modal, or
  // expire behind it unseen.
  it("waits under a modal and gives what arrived there a fair look afterwards", () => {
    const { result, rerender } = setup([], true);
    rerender({ candidates: [notice("usb-disconnected")], suppressed: true });
    rerender({ candidates: [], suppressed: true });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);
    expect(result.current.announced).toBeNull();

    rerender({ candidates: [], suppressed: false });
    expect(result.current.announced?.notice.id).toBe("usb-disconnected");
    act(() => {
      vi.advanceTimersByTime(NOTICE_MIN_VISIBLE_MS - 1);
    });
    expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.entries).toEqual([]);
  });

  describe("dismissing", () => {
    it("hides one occurrence, and shows the next one the source raises", () => {
      const first = { reason: "a" };
      const { result, rerender } = setup([notice("start-failed", { source: first })]);

      act(() => result.current.dismiss(result.current.entries[0]));
      expect(result.current.entries).toEqual([]);

      rerender({ candidates: [notice("start-failed", { source: first })], suppressed: false });
      expect(result.current.entries).toEqual([]);

      rerender({ candidates: [notice("start-failed", { source: { reason: "a" } })], suppressed: false });
      expect(ids(result.current.entries)).toEqual(["start-failed"]);
    });

    it("counts leaving and coming back as a new occurrence", () => {
      const { result, rerender } = setup([notice("usb-disconnected")]);
      act(() => result.current.dismiss(result.current.entries[0]));
      rerender({ candidates: [], suppressed: false });
      rerender({ candidates: [notice("usb-disconnected")], suppressed: false });
      expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);
    });

    it("runs the notice's own dismiss, which is how onboarding completes", () => {
      const onDismiss = vi.fn();
      const { result } = setup([notice("onboarding", { kind: "condition", onDismiss })]);
      act(() => result.current.dismiss(result.current.entries[0]));
      expect(onDismiss).toHaveBeenCalledOnce();
    });
  });

  it("announces each new top notice once, not every re-render or re-surfacing", () => {
    const low = notice("usb-disconnected");
    const high = notice("capture-permission", { tier: NOTICE_TIER.ERROR_CONDITION, kind: "condition" });
    const { result, rerender } = setup([low]);
    const first = result.current.announced;
    expect(first?.notice.id).toBe("usb-disconnected");

    rerender({ candidates: [low], suppressed: false });
    expect(result.current.announced).toBe(first);

    rerender({ candidates: [high, low], suppressed: false });
    expect(result.current.announced?.notice.id).toBe("capture-permission");

    // Back on top, but already spoken.
    rerender({ candidates: [low], suppressed: false });
    expect(result.current.announced?.notice.id).toBe("capture-permission");
  });

  it("collapses once nothing is left to expand into", () => {
    const { result, rerender } = setup([notice("usb-disconnected"), notice("hue-color")]);
    act(() => result.current.setExpanded(true));
    expect(result.current.expanded).toBe(true);

    rerender({ candidates: [], suppressed: false });
    rerender({ candidates: [notice("hue-color", { source: "again" })], suppressed: false });
    expect(result.current.expanded).toBe(false);
  });

  // The queue keys on content; a second button that changed must not be
  // shown as it was.
  it("shows a notice's second action as the source last built it", () => {
    const action = (label: string, pending = false) => ({ label, onClick: () => {}, pending });
    const offline = (secondary: string, pending = false) =>
      notice("output-none", { kind: "condition", dismissible: false, secondaryAction: action(secondary, pending) });
    const { result, rerender } = setup([offline("Open devices")]);

    rerender({ candidates: [offline("Open Hue")], suppressed: false });
    expect(result.current.entries[0]?.notice.secondaryAction?.label).toBe("Open Hue");

    rerender({ candidates: [offline("Open Hue", true)], suppressed: false });
    expect(result.current.entries[0]?.notice.secondaryAction?.pending).toBe(true);
  });
  // Devices → Hue draws these as the card's state; the strip said them again.
  describe("deferring to the screen on view", () => {
    function setupWithView(initial: ShellNotice[], view: NoticeView | null) {
      return renderHook(
        ({ candidates, view }) => useShellNoticeQueue(candidates, { suppressed: false, view }),
        { initialProps: { candidates: initial, view } },
      );
    }
    const hueNotice = notice("hue-left-out", { shownBy: NOTICE_VIEW.DEVICES_HUE });

    it("hides a notice the screen shows, and only that one", () => {
      const { result } = setupWithView([hueNotice, notice("usb-disconnected")], NOTICE_VIEW.DEVICES_HUE);
      expect(ids(result.current.entries)).toEqual(["usb-disconnected"]);
      expect(result.current.announced?.notice.id).toBe("usb-disconnected");
    });

    it("brings the same occurrence back when the user leaves", () => {
      const { result, rerender } = setupWithView([hueNotice], null);
      const key = result.current.entries[0]?.key;

      rerender({ candidates: [hueNotice], view: NOTICE_VIEW.DEVICES_HUE });
      expect(result.current.entries).toEqual([]);

      rerender({ candidates: [hueNotice], view: null });
      expect(result.current.entries.map((entry) => entry.key)).toEqual([key]);
    });

    it("keeps a dismissed notice dismissed across the visit", () => {
      const { result, rerender } = setupWithView([hueNotice], null);
      act(() => result.current.dismiss(result.current.entries[0]));

      rerender({ candidates: [hueNotice], view: NOTICE_VIEW.DEVICES_HUE });
      rerender({ candidates: [hueNotice], view: null });
      expect(result.current.entries).toEqual([]);
    });
  });
});
