// LED Setup's draft: when it counts as unsaved, what happens to it on the way
// out, how a failed save is reported, and whether a running test follows it.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type * as modeApiModule from "@/features/mode/modeApi";
import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";
import type { LeaveGuard } from "@/features/shell/navigationStore";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
} from "@/shared/contracts/display";
import { LED_TEST_STATUS, type LedTestStatusCode } from "@/shared/contracts/preview";
import { invokeFromCommands } from "@/test/mockCommands";

import { CalibrationPage } from "../CalibrationPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn<typeof invoke>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: () => Promise.resolve() }),
}));

const saveMock = vi.fn<typeof shellStoreType.save>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: Parameters<typeof shellStoreType.save>[0]) => saveMock(partial),
  },
}));

vi.mock("@/features/mode/modeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/mode/modeApi")>()),
  acquireHueForTest: vi.fn<typeof modeApiModule.acquireHueForTest>(),
  releaseHueAfterTest: vi.fn<typeof modeApiModule.releaseHueAfterTest>(),
}));

const DISPLAYS: DisplayInfo[] = [
  { id: "display-1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, isPrimary: true },
];

const OVERLAY_OPENED: DisplayOverlayCommandResult = { ok: true, code: DISPLAY_OVERLAY_STATUS.OPENED, message: "" };

const SAVED: LedCalibrationConfig = {
  counts: { top: 40, right: 20, bottom: 40, left: 20 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 120,
};

/** Layouts each `start_led_test_pattern` call carried, in order. */
let startedWith: Array<LedCalibrationConfig | undefined> = [];
/** Status the next start answers with; a started test by default. */
let startStatus: LedTestStatusCode = LED_TEST_STATUS.PATTERN_STARTED;

beforeEach(() => {
  startedWith = [];
  startStatus = LED_TEST_STATUS.PATTERN_STARTED;
  saveMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_displays: DISPLAYS,
      open_display_overlay: OVERLAY_OPENED,
      close_display_overlay: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.CLOSED },
      update_display_overlay_preview: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.PREVIEW_SYNCED },
      start_led_test_pattern: ({ payload }) => {
        startedWith.push(payload.ledCalibration ?? undefined);
        const active = startStatus === LED_TEST_STATUS.PATTERN_STARTED;
        return { active, previewOnly: false, status: { code: startStatus, message: "", details: null } };
      },
      stop_led_test_pattern: {
        active: false,
        previewOnly: false,
        status: { code: LED_TEST_STATUS.PATTERN_STOPPED, message: "", details: null },
      },
    }),
  );
});

interface Rendered {
  onNavigateBack: Mock<() => void>;
  onSaved: Mock<(config: LedCalibrationConfig) => void>;
  guard: () => LeaveGuard;
}

async function renderPage(props: Partial<Parameters<typeof CalibrationPage>[0]> = {}): Promise<Rendered> {
  const onNavigateBack = vi.fn<() => void>();
  const onSaved = vi.fn<(config: LedCalibrationConfig) => void>();
  let guard: LeaveGuard | null = null;
  render(
    <CalibrationPage
      onNavigateBack={onNavigateBack}
      onSaved={onSaved}
      registerLeaveGuard={(next) => {
        guard = next;
      }}
      {...props}
    />,
  );
  await screen.findByText("Display 1");
  return {
    onNavigateBack,
    onSaved,
    guard: () => {
      if (!guard) throw new Error("no leave guard registered");
      return guard;
    },
  };
}

const increaseTop = () => screen.getAllByRole("button", { name: "calibration:page.aria.countIncrease" });
const dialog = () => screen.queryByTestId("calibration-discard-dialog");

// The first visit — the total asked for first, and an automatic fill that is
// not unsaved work — is in CalibrationPage.totalStep.test.tsx.

describe("CalibrationPage — leaving with an unsaved draft", () => {
  it("lets a clean page go without asking", async () => {
    const page = await renderPage({ initialConfig: SAVED });
    expect(page.guard()(vi.fn<() => void>())).toBe(false);
  });

  it("holds the move, asks, and on Discard goes where the user was heading", async () => {
    const user = userEvent.setup();
    const page = await renderPage({ initialConfig: SAVED });
    await user.click(increaseTop()[0]);

    const proceed = vi.fn<() => void>();
    let held = false;
    act(() => {
      held = page.guard()(proceed);
    });
    expect(held).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(proceed).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "calibration:overlay.discard" }));

    expect(proceed).toHaveBeenCalledTimes(1);
    // The held move replaces the page's own exit; it must not also go to Lights.
    expect(page.onNavigateBack).not.toHaveBeenCalled();
  });

  it("stays put on Keep editing, and forgets the held move", async () => {
    const user = userEvent.setup();
    const page = await renderPage({ initialConfig: SAVED });
    await user.click(increaseTop()[0]);

    const proceed = vi.fn<() => void>();
    act(() => {
      page.guard()(proceed);
    });
    await user.click(screen.getByRole("button", { name: "calibration:overlay.keepEditing" }));

    expect(dialog()).toBeNull();
    // A later move is held on its own; Discard sends the user there, not to the forgotten one.
    const later = vi.fn<() => void>();
    act(() => {
      page.guard()(later);
    });
    await user.click(screen.getByRole("button", { name: "calibration:overlay.discard" }));
    expect(proceed).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("CalibrationPage — saving and Cancel", () => {
  it("stays on the page after a save and shows it saved", async () => {
    const user = userEvent.setup();
    const page = await renderPage({ initialConfig: SAVED });
    const revert = () => screen.queryByRole("button", { name: "calibration:setup.revert" });
    const save = () => screen.queryByRole("button", { name: "calibration:overlay.save" });
    // At rest the capsule says the layout is saved; there is nothing to press.
    expect(screen.getByText("calibration:setup.savedState")).toBeInTheDocument();
    expect(save()).toBeNull();
    expect(revert()).toBeNull();

    await user.click(increaseTop()[0]);
    expect(save()).toHaveAttribute("title", "calibration:setup.unsaved");
    expect(revert()).toBeInTheDocument();
    await user.click(save()!);

    await waitFor(() => expect(page.onSaved).toHaveBeenCalledTimes(1));
    expect(page.onNavigateBack).not.toHaveBeenCalled();
    expect(await screen.findByText("calibration:setup.saved")).toBeInTheDocument();
    expect(save()).toBeNull();
    expect(revert()).toBeNull();
    expect(page.guard()(vi.fn<() => void>())).toBe(false);
  });

  it("puts the saved layout back on Cancel, without leaving", async () => {
    const user = userEvent.setup();
    const page = await renderPage({ initialConfig: SAVED });
    const values = () => screen.getAllByRole("button", { name: "calibration:page.aria.countInput" }).map((b) => b.textContent);
    const before = values();

    await user.click(increaseTop()[0]);
    await user.click(screen.getByRole("button", { name: "calibration:setup.revert" }));

    const after = values();
    expect(after).toEqual(before);
    expect(dialog()).toBeNull();
    expect(page.onNavigateBack).not.toHaveBeenCalled();
  });
});

describe("CalibrationPage — a failed save", () => {
  it("says so, keeps the draft, and Retry saves it", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    saveMock.mockRejectedValueOnce(new Error("disk full"));
    const page = await renderPage({ initialConfig: SAVED });
    await user.click(increaseTop()[0]);

    await user.click(screen.getByRole("button", { name: "calibration:overlay.save" }));

    expect(await screen.findByText("calibration:overlay.errors.saveFailed")).toBeInTheDocument();
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      "[LumaSync] LED Setup could not save the layout:",
      expect.any(Error),
    );
    expect(page.onSaved).not.toHaveBeenCalled();
    expect(page.onNavigateBack).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "calibration:overlay.retrySave" }));

    await waitFor(() => expect(page.onSaved).toHaveBeenCalledTimes(1));
    expect(page.onSaved.mock.calls[0][0].counts.top).toBe(41);
    consoleError.mockRestore();
  });

  it("drops the failure once Revert puts the saved layout back", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    saveMock.mockRejectedValueOnce(new Error("disk full"));
    await renderPage({ initialConfig: SAVED });
    await user.click(increaseTop()[0]);
    await user.click(screen.getByRole("button", { name: "calibration:overlay.save" }));
    expect(await screen.findByText("calibration:overlay.errors.saveFailed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "calibration:setup.revert" }));

    expect(screen.queryByText("calibration:overlay.errors.saveFailed")).toBeNull();
    consoleError.mockRestore();
  });
});

describe("CalibrationPage — editing while the test runs", () => {
  // The chase got its layout once, at start: the canvas and overlay followed
  // an edit, the strip never did.
  it("restarts the running test with the edited layout", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });
    await user.click(screen.getByRole("button", { name: "calibration:setup.test" }));
    await screen.findByRole("button", { name: "calibration:setup.stop" });
    expect(startedWith).toHaveLength(1);

    await user.click(increaseTop()[0]);
    expect(screen.getByTestId("calibration-test-stale")).toBeInTheDocument();

    await waitFor(() => expect(startedWith).toHaveLength(2), { timeout: 2000 });
    expect(startedWith[1]?.counts.top).toBe(41);
    await waitFor(() => expect(screen.queryByTestId("calibration-test-stale")).toBeNull());
  });
});

describe("CalibrationPage — a refused test", () => {
  it("explains the refusal in the user's words and keeps the code as detail", async () => {
    const user = userEvent.setup();
    startStatus = LED_TEST_STATUS.PATTERN_INVALID_PARAMS;
    await renderPage({ initialConfig: SAVED });

    await user.click(screen.getByRole("button", { name: "calibration:setup.test" }));

    expect(await screen.findByText("calibration:overlay.errors.testPatternInvalidLayout")).toBeInTheDocument();
    expect(screen.getByText(LED_TEST_STATUS.PATTERN_INVALID_PARAMS)).toBeInTheDocument();
  });
});

describe("CalibrationPage — picking the first LED from its list", () => {
  it("moves LED #1 to the picked place, then closes the list", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });
    const chip = () => screen.getByRole("button", { name: /calibration:setup\.firstLed/ });
    const before = chip().getAttribute("aria-label");

    await user.click(chip());
    const options = screen.getAllByRole("option");
    const target = options.find((o) => o.getAttribute("aria-selected") === "false")!;
    await user.click(target);

    await waitFor(() => expect(chip().getAttribute("aria-label")).not.toBe(before));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(chip().getAttribute("aria-label")).toContain(target.textContent ?? "");
  });
});
