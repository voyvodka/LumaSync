// Windows 1.5.4 report: a check that never reached the feed was shown as a
// failed installation, explained by the plugin's raw endpoint-URL message.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UPDATER_STATUS } from "@/shared/contracts/updater";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

const { UpdateModal } = await import("../UpdateModal");

const FEED_URL = "https://github.com/voyvodka/LumaSync/releases/latest/download/latest.json";

function renderError(code: string | undefined, message: string) {
  render(
    <UpdateModal
      state={{ status: "error", code: code as never, message }}
      onInstall={vi.fn()}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

describe("UpdateModal error wording", () => {
  it("does not call an unreachable feed a failed installation", () => {
    renderError(UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.title")).not.toBeInTheDocument();
  });

  it("demotes the raw message to a technical detail rather than the explanation", () => {
    renderError(UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.detailTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.boxTitle")).not.toBeInTheDocument();
  });

  it("uses the same wording when the endpoint itself is unusable", () => {
    renderError(UPDATER_STATUS.ENDPOINT_INVALID, "invalid endpoint");

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
  });

  /// A genuine install failure keeps the wording it had — that one really is a
  /// failed installation, and its message is worth reading.
  it("still reports an install failure as an install failure", () => {
    renderError(UPDATER_STATUS.INSTALL_FAILED, "signature mismatch");

    expect(screen.getByText("updater:error.title")).toBeInTheDocument();
    expect(screen.getByText("updater:error.boxTitle")).toBeInTheDocument();
  });

  /// The invoke layer itself failing carries no code, and that is not a
  /// diagnosis — it must not be dressed up as one.
  it("falls back to the generic wording when there is no code", () => {
    renderError(undefined, "window torn down mid-check");

    expect(screen.getByText("updater:error.title")).toBeInTheDocument();
  });
});
