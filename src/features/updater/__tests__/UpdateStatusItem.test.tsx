import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithShellStores } from "@/test/shellProviders";
import type { UpdateMetadata } from "@/shared/contracts/updater";
import { UpdateStatusItem } from "../UpdateStatusItem";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const UPDATE: UpdateMetadata = { currentVersion: "1.2.0", version: "1.3.0", date: null, body: null };

describe("UpdateStatusItem", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("offers an update that is ready but not on screen, and opens it on a press", () => {
    const controls = renderWithShellStores(<UpdateStatusItem compact={false} />, {
      updater: { state: { status: "available", update: UPDATE }, isModalOpen: false },
    });

    const item = screen.getByTestId("update-status-item");
    item.click();
    expect(controls.updaterActions.showUpdate).toHaveBeenCalledTimes(1);
  });

  it("stays away while the prompt itself shows the update, and fades out when it opens", () => {
    vi.useFakeTimers();
    const controls = renderWithShellStores(<UpdateStatusItem compact />, {
      updater: { state: { status: "available", update: UPDATE }, isModalOpen: true },
    });
    expect(screen.queryByTestId("update-status-item")).toBeNull();

    act(() => {
      controls.updater.set({ ...controls.updater.get(), isModalOpen: false });
    });
    expect(screen.getByTestId("update-status-item")).toHaveTextContent("updater:statusItem.short");

    act(() => {
      controls.updater.set({ ...controls.updater.get(), isModalOpen: true });
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId("update-status-item")).toBeNull();
  });
});
