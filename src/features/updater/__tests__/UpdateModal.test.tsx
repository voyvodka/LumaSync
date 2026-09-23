// Windows 1.5.4 report: a check that never reached the feed was shown as a
// failed installation, explained by the plugin's raw endpoint-URL message.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UPDATER_STATUS } from "@/shared/contracts/updater";
import type { UpdaterErrorPhase } from "../useAutoUpdater";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

const { UpdateModal } = await import("../UpdateModal");

const FEED_URL = "https://github.com/voyvodka/LumaSync/releases/latest/download/latest.json";

function renderError(phase: UpdaterErrorPhase, code: string | undefined, message: string) {
  render(
    <UpdateModal
      state={{ status: "error", phase, code: code as never, message }}
      onInstall={vi.fn()}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

describe("UpdateModal error wording", () => {
  it("does not call an unreachable feed a failed installation", () => {
    renderError("check", UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.title")).not.toBeInTheDocument();
  });

  it("demotes the raw message to a technical detail rather than the explanation", () => {
    renderError("check", UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.detailTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.boxTitle")).not.toBeInTheDocument();
  });

  it("uses the same wording when the endpoint itself is unusable", () => {
    renderError("check", UPDATER_STATUS.ENDPOINT_INVALID, "invalid endpoint");

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
  });

  /// Seen in a real window: a broken build rejected the check at the invoke
  /// layer, which carries no code, and the modal said "installation could not
  /// be completed" about an app that had installed nothing.
  it("calls an uncoded check rejection a check failure, not a failed installation", () => {
    renderError("check", undefined, "check_for_update not allowed");

    expect(screen.getByText("updater:error.checkEyebrow")).toBeInTheDocument();
    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.title")).not.toBeInTheDocument();
  });

  /// A genuine install failure keeps the wording it had — that one really is a
  /// failed installation, and its message is worth reading.
  it("still reports an install failure as an install failure", () => {
    renderError("install", UPDATER_STATUS.INSTALL_FAILED, "signature mismatch");

    expect(screen.getByText("updater:error.title")).toBeInTheDocument();
    expect(screen.getByText("updater:error.boxTitle")).toBeInTheDocument();
  });

  it("reports an uncoded install rejection as an install failure", () => {
    renderError("install", undefined, "window torn down mid-install");

    expect(screen.getByText("updater:error.title")).toBeInTheDocument();
  });
});

describe("UpdateModal markup", () => {
  // The e2e helpers and the ui-audit probe find an open prompt by role.
  it("renders as a labelled modal dialog", () => {
    renderError("check", UPDATER_STATUS.CHECK_FAILED, "offline");

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "lm-updater-title");
  });
});
