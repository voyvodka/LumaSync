// LED Setup asks for the strip's total before anything else when there is no
// saved layout, and splits it over the edges by the display's shape. The old
// first fill guessed counts from the display's pixel width, so a 3600-px
// laptop panel got 164 LEDs whatever strip was on it.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type * as modeApiModule from "@/features/mode/modeApi";
import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { ShellState } from "@/shared/contracts/shell";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
} from "@/shared/contracts/display";
import { WLED_PROTOCOL } from "@/shared/contracts/device";
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

let storedShell: Partial<ShellState> = {};
const saveMock = vi.fn<typeof shellStoreType.save>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(storedShell),
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
  { id: "display-2", label: "Portrait", width: 1080, height: 1920, x: 1920, y: 0, scaleFactor: 1, isPrimary: false },
];

const OVERLAY_OPENED: DisplayOverlayCommandResult = { ok: true, code: DISPLAY_OVERLAY_STATUS.OPENED, message: "" };

const SAVED: LedCalibrationConfig = {
  counts: { top: 40, right: 20, bottom: 0, left: 20 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 80,
};

beforeEach(() => {
  storedShell = {};
  saveMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_displays: DISPLAYS,
      open_display_overlay: OVERLAY_OPENED,
      close_display_overlay: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.CLOSED },
      update_display_overlay_preview: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.PREVIEW_SYNCED },
    }),
  );
});

async function renderPage(
  props: Partial<Parameters<typeof CalibrationPage>[0]> = {},
): Promise<{ onNavigateBack: Mock<() => void> }> {
  const onNavigateBack = vi.fn<() => void>();
  render(<CalibrationPage onNavigateBack={onNavigateBack} onSaved={vi.fn<(config: LedCalibrationConfig) => void>()} {...props} />);
  await screen.findByText("Display 1");
  return { onNavigateBack };
}

const step = () => screen.queryByTestId("calibration-total-step");
const totalInput = () => screen.getByLabelText("calibration:page.totalStep.question");
const edgeValues = () =>
  screen
    .getAllByRole("textbox", { name: "calibration:page.aria.countInput" })
    .map((input) => Number((input as HTMLInputElement).value));
const dialog = () => screen.queryByTestId("calibration-discard-dialog");

describe("LED Setup with no saved layout", () => {
  it("asks for the total first and guesses no counts from the display", async () => {
    const user = userEvent.setup();
    const page = await renderPage();

    expect(step()).not.toBeNull();
    expect(totalInput()).toHaveValue("");
    expect(screen.queryAllByRole("textbox", { name: "calibration:page.aria.countInput" })).toHaveLength(0);

    // Nothing was entered, so there is nothing to discard.
    await user.click(screen.getByRole("button", { name: "calibration:overlay.cancel" }));
    expect(dialog()).toBeNull();
    expect(page.onNavigateBack).toHaveBeenCalledTimes(1);
  });

  it("splits a typed total over the edges so they add up to it exactly", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(totalInput(), "121");
    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.apply" }));

    expect(step()).toBeNull();
    // Top, right, bottom, left on a 16:9 display.
    expect(edgeValues()).toEqual([39, 22, 38, 22]);
    expect(screen.getByRole("button", { name: "calibration:page.totalStep.change" })).toHaveFocus();
  });

  it("counts the split as the user's edit, so leaving asks", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(totalInput(), "120{Enter}");
    expect(step()).toBeNull();
    await user.click(screen.getByRole("button", { name: "calibration:overlay.cancel" }));

    expect(dialog()).not.toBeNull();
  });

  it("splits only over the edges the strip runs along", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(totalInput(), "120");
    await user.click(screen.getByRole("button", { name: "calibration:page.edgeBottom" }));
    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.apply" }));

    expect(edgeValues()).toEqual([56, 32, 0, 32]);
  });

  it("refuses a total out of range, and no edges at all", async () => {
    const user = userEvent.setup();
    await renderPage();
    const apply = () => screen.getByRole("button", { name: "calibration:page.totalStep.apply" });

    await user.type(totalInput(), "0");
    expect(apply()).toBeDisabled();
    expect(totalInput()).toHaveAttribute("aria-invalid", "true");

    await user.clear(totalInput());
    await user.type(totalInput(), "90");
    expect(apply()).toBeEnabled();
    for (const edge of ["edgeTop", "edgeRight", "edgeBottom", "edgeLeft"]) {
      await user.click(screen.getByRole("button", { name: `calibration:page.${edge}` }));
    }
    expect(apply()).toBeDisabled();
    expect(screen.getByText("calibration:page.totalStep.noEdges")).toBeInTheDocument();
  });

  it("lets the user skip to setting each edge by hand", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.skip" }));

    expect(step()).toBeNull();
    expect(edgeValues()).toEqual([0, 0, 0, 0]);
  });
});

describe("LED Setup with a bound WLED panel", () => {
  beforeEach(() => {
    storedShell = {
      lastWledSink: { ip: "192.168.1.40", port: 4048, ledCount: 150, protocol: WLED_PROTOCOL.DDP },
    };
  });

  it("pre-fills the panel's own count, already split, without counting it as unsaved", async () => {
    const user = userEvent.setup();
    const page = await renderPage();

    await waitFor(() => expect(totalInput()).toHaveValue("150"));
    expect(screen.getByText("calibration:page.totalStep.fromWled")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "calibration:overlay.cancel" }));
    expect(dialog()).toBeNull();
    expect(page.onNavigateBack).toHaveBeenCalledTimes(1);
  });

  it("re-splits the untouched fill for a display of another shape", async () => {
    const user = userEvent.setup();
    await renderPage();
    await waitFor(() => expect(totalInput()).toHaveValue("150"));

    await user.click(screen.getByRole("radio", { name: /Portrait/ }));
    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.apply" }));

    // 150 over a 9:16 perimeter: the sides are the long edges now.
    expect(edgeValues()).toEqual([27, 48, 27, 48]);
  });

  it("offers the panel's count, not a saved total that disagrees with it", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });
    expect(step()).toBeNull();

    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.change" }));

    expect(totalInput()).toHaveValue("150");
  });
});

describe("LED Setup with a saved layout", () => {
  it("opens straight on the per-edge editor", async () => {
    await renderPage({ initialConfig: SAVED });

    expect(step()).toBeNull();
    expect(edgeValues()).toEqual([40, 20, 0, 20]);
  });

  it("re-splits a changed total over the edges the layout lights", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await user.click(screen.getByRole("button", { name: "calibration:page.totalStep.change" }));
    expect(totalInput()).toHaveFocus();
    expect(totalInput()).toHaveValue("80");
    expect(screen.getByRole("button", { name: "calibration:page.edgeBottom" })).toHaveAttribute("aria-pressed", "false");

    await user.clear(totalInput());
    await user.type(totalInput(), "120{Enter}");

    expect(edgeValues()).toEqual([56, 32, 0, 32]);
  });

  it("keeps the total on Reset and splits it over all four edges again", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await user.click(screen.getByRole("button", { name: "calibration:page.reset" }));

    expect(edgeValues()).toEqual([26, 14, 26, 14]);
  });
});
