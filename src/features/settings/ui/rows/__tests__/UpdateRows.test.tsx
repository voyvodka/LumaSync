import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { time?: string }) => (opts?.time ? `${key}(${opts.time})` : key),
    i18n: { language: "en" },
  }),
}));

import { checkedTime, UpdateCheckRow } from "../UpdateRows";

describe("UpdateCheckRow last check", () => {
  afterEach(cleanup);

  it("opens empty until a check has answered, with no placeholder to slide from", () => {
    render(<UpdateCheckRow onCheckForUpdates={vi.fn<() => void>()} isCheckingForUpdates={false} localOutputConnected={false} lastCheckedAt={null} />);
    expect(screen.queryByText(/updater:lastChecked/)).toBeNull();
  });

  it("says when the feed was last read", () => {
    const at = new Date(2026, 9, 7, 14, 32).getTime();
    render(<UpdateCheckRow onCheckForUpdates={vi.fn<() => void>()} isCheckingForUpdates={false} localOutputConnected={false} lastCheckedAt={at} />);
    expect(screen.getByText(`updater:lastChecked(${checkedTime(at, "en")})`)).toBeInTheDocument();
  });
});

describe("checkedTime", () => {
  const at = new Date(2026, 9, 7, 14, 32).getTime();

  it("gives the time alone for today", () => {
    const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(at);
    expect(checkedTime(at, "en", new Date(2026, 9, 7, 18, 0).getTime())).toBe(time);
  });

  it("gives the day with it for an earlier day", () => {
    const text = checkedTime(at, "en", new Date(2026, 9, 8, 9, 0).getTime());
    expect(text).toContain("Oct");
    expect(text).toContain("7");
  });
});
