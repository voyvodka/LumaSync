// Windows 1.5.4 report: a check that never reached the feed was shown as a
// failed installation, explained by the plugin's raw endpoint-URL message.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UPDATER_STATUS, type UpdateMetadata } from "@/shared/contracts/updater";
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
      onInstall={vi.fn<(update: UpdateMetadata) => void>()}
      onDismiss={vi.fn<() => void>()}
      onRetry={vi.fn<() => void>()}
    />,
  );
}

describe("UpdateModal error wording", () => {
  it("does not call an unreachable feed a failed installation", () => {
    renderError("check", UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.title")).not.toBeInTheDocument();
  });

  it("keeps the raw message behind Details rather than as the explanation", () => {
    renderError("check", UPDATER_STATUS.CHECK_FAILED, `Could not fetch ${FEED_URL}`);

    expect(screen.getByText("updater:error.checkBody")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "updater:error.details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toHaveTextContent(`Could not fetch ${FEED_URL}`);

    act(() => {
      toggle.click();
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
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

    expect(screen.getByText("updater:error.checkTitle")).toBeInTheDocument();
    expect(screen.queryByText("updater:error.title")).not.toBeInTheDocument();
  });

  /// A genuine install failure keeps the wording it had — that one really is a
  /// failed installation, and its message is worth reading.
  it("still reports an install failure as an install failure", () => {
    renderError("install", UPDATER_STATUS.INSTALL_FAILED, "signature mismatch");

    expect(screen.getByText("updater:error.title")).toBeInTheDocument();
    expect(screen.getByText("signature mismatch")).toBeInTheDocument();
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

describe("UpdateModal states", () => {
  const UPDATE: UpdateMetadata = {
    currentVersion: "1.2.0",
    version: "1.3.0",
    date: "2026-04-13",
    body: ["### Added", "- Multi-bridge Hue", "### Fixed", "- Permission loop", "- Frame drift"].join("\n"),
  };
  const handlers = {
    onInstall: vi.fn<(update: UpdateMetadata) => void>(),
    onDismiss: vi.fn<() => void>(),
    onRetry: vi.fn<() => void>(),
  };

  it("groups the release notes under the changelog's own headings", () => {
    render(<UpdateModal state={{ status: "available", update: UPDATE }} {...handlers} />);

    expect(screen.getByRole("heading", { name: "updater:noteKind.add" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "updater:noteKind.fix" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Multi-bridge Hue",
      "Permission loop",
      "Frame drift",
    ]);
  });

  it("shows download progress as a filling bar with one line under it, and nothing that loops", () => {
    render(
      <UpdateModal
        state={{
          status: "downloading",
          update: UPDATE,
          progress: 62,
          downloadedBytes: 8_800_000,
          totalBytes: 14_200_000,
          bytesPerSecond: 2_300_000,
          etaSeconds: 2,
        }}
        {...handlers}
      />,
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByText(/updater:downloading\.amount · updater:downloading\.left/)).toBeInTheDocument();
  });

  it("offers no way out while installing, outside dev builds", () => {
    render(<UpdateModal state={{ status: "installing", update: UPDATE }} {...handlers} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("updater:installing.body")).toBeInTheDocument();
  });
});

describe("UpdateModal retry", () => {
  it("keeps the failure up while Try again checks, and says so on the button", () => {
    render(
      <UpdateModal
        state={{ status: "error", phase: "check", message: "offline", retrying: true }}
        onInstall={vi.fn<(update: UpdateMetadata) => void>()}
        onDismiss={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
      />,
    );

    const retry = screen.getByRole("button", { name: /updater:checking/ });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
  });
});
