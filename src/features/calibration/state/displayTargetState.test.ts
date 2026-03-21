import { describe, expect, it, vi } from "vitest";

import type { DisplayOverlayCommandResult } from "../../../shared/contracts/display";
import { createDisplayTargetState } from "./displayTargetState";

function okResult(code = "OVERLAY_OPENED"): DisplayOverlayCommandResult {
  return {
    ok: true,
    code,
    message: code,
  };
}

function createState() {
  const openDisplayOverlay = vi.fn<
    (displayId: string, preview?: unknown) => Promise<DisplayOverlayCommandResult>
  >(async () => okResult());
  const closeDisplayOverlay = vi.fn<(displayId: string) => Promise<DisplayOverlayCommandResult>>(async () =>
    okResult("OVERLAY_CLOSED"),
  );
  const state = createDisplayTargetState({
    openDisplayOverlay,
    closeDisplayOverlay,
  });

  state.setDisplays([
    {
      id: "display-1",
      label: "Display 1",
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      isPrimary: true,
    },
    {
      id: "display-2",
      label: "Display 2",
      width: 2560,
      height: 1440,
      x: 1920,
      y: 0,
      isPrimary: false,
    },
  ]);

  return { state, openDisplayOverlay, closeDisplayOverlay };
}

describe("displayTargetState", () => {
  it("switchActiveDisplay: picks primary display as default target", () => {
    const openDisplayOverlay = vi.fn<
      (displayId: string, preview?: unknown) => Promise<DisplayOverlayCommandResult>
    >(async () => okResult());
    const closeDisplayOverlay = vi.fn<(displayId: string) => Promise<DisplayOverlayCommandResult>>(async () =>
      okResult("OVERLAY_CLOSED"),
    );
    const state = createDisplayTargetState({
      openDisplayOverlay,
      closeDisplayOverlay,
    });

    state.setDisplays([
      { id: "display-2", label: "Display 2", width: 2560, height: 1440, x: 1920, y: 0, isPrimary: false },
      { id: "display-1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, isPrimary: true },
    ]);

    expect(state.getSnapshot().selectedDisplayId).toBe("display-1");
  });

  it("single-active: closes old overlay before opening next display", async () => {
    const { state, openDisplayOverlay, closeDisplayOverlay } = createState();

    await state.switchActiveDisplay("display-1");
    await state.switchActiveDisplay("display-2");

    expect(closeDisplayOverlay).toHaveBeenNthCalledWith(1, "display-1");
    expect(openDisplayOverlay).toHaveBeenNthCalledWith(1, "display-1", undefined);
    expect(openDisplayOverlay).toHaveBeenNthCalledWith(2, "display-2", undefined);
    expect(state.getSnapshot().activeDisplayId).toBe("display-2");
  });

  it("OVERLAY_OPEN_FAILED: enters blocked state and preserves failure reason", async () => {
    const { state, openDisplayOverlay } = createState();
    openDisplayOverlay.mockImplementation(async (displayId) => {
      if (displayId === "display-2") {
        return {
          ok: false,
          code: "OVERLAY_OPEN_FAILED",
          message: "Overlay cannot open",
          reason: "Permission denied",
        } satisfies DisplayOverlayCommandResult;
      }

      return okResult();
    });

    await state.switchActiveDisplay("display-1");
    const blocked = await state.switchActiveDisplay("display-2");

    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedCode).toBe("OVERLAY_OPEN_FAILED");
    expect(blocked.blockedReason).toContain("Permission denied");
    expect(blocked.activeDisplayId).toBeNull();
  });

  it("switchActiveDisplay OVERLAY_OPEN_FAILED: blocks re-open attempts until blocked state clears", async () => {
    const { state, openDisplayOverlay } = createState();
    openDisplayOverlay.mockImplementation(async (displayId) => {
      if (displayId === "display-2") {
        return {
          ok: false,
          code: "OVERLAY_OPEN_FAILED",
          message: "Overlay cannot open",
          reason: "Display permission denied",
        } satisfies DisplayOverlayCommandResult;
      }

      return okResult();
    });

    const blocked = await state.switchActiveDisplay("display-2");
    expect(blocked.blocked).toBe(true);

    const retry = await state.switchActiveDisplay("display-1");
    expect(retry.blocked).toBe(true);
    expect(openDisplayOverlay).toHaveBeenCalledTimes(1);

    state.clearBlockedState();
    const reopened = await state.switchActiveDisplay("display-1");
    expect(reopened.blocked).toBe(false);
    expect(reopened.activeDisplayId).toBe("display-1");
    expect(openDisplayOverlay).toHaveBeenCalledTimes(2);
  });

  it("single-active: rejects parallel open attempts while switch in progress", async () => {
    let resolveOpen!: () => void;
    const openDisplayOverlay = vi.fn(
      () =>
        new Promise<DisplayOverlayCommandResult>((resolve) => {
          resolveOpen = () => resolve(okResult());
        }),
    );
    const closeDisplayOverlay = vi.fn<(displayId: string) => Promise<DisplayOverlayCommandResult>>(async () =>
      okResult("OVERLAY_CLOSED"),
    );
    const state = createDisplayTargetState({
      openDisplayOverlay,
      closeDisplayOverlay,
    });

    state.setDisplays([
      { id: "display-1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, isPrimary: true },
    ]);

    const first = state.switchActiveDisplay("display-1");
    const second = state.switchActiveDisplay("display-1");
    resolveOpen();
    await Promise.all([first, second]);

    expect(openDisplayOverlay).toHaveBeenCalledTimes(1);
    expect(state.getSnapshot().isSwitching).toBe(false);
  });
});
