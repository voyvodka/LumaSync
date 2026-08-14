import { describe, expect, it, vi } from "vitest";

import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayOverlayCommandResult,
  type DisplayOverlayStatusCode,
} from "@/shared/contracts/display";
import { createDisplayTargetState } from "../displayTargetState";

function okResult(
  code: DisplayOverlayStatusCode = DISPLAY_OVERLAY_STATUS.OPENED,
): DisplayOverlayCommandResult {
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

describe("switchActiveDisplay — rapid clicks", () => {
  /** Adds a display so a three-way race has somewhere to land. */
  function createThreeDisplayState() {
    const harness = createState();
    harness.state.setDisplays([
      { id: "display-1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, isPrimary: true },
      { id: "display-2", label: "Display 2", width: 2560, height: 1440, x: 1920, y: 0, isPrimary: false },
      { id: "display-3", label: "Display 3", width: 1280, height: 720, x: 4480, y: 0, isPrimary: false },
    ]);
    return harness;
  }

  it("settles on the display clicked last, not the one clicked first", async () => {
    const { state, openDisplayOverlay } = createThreeDisplayState();

    // Both start before either resolves — the second used to be handed the
    // first one's promise and its displayId dropped entirely.
    const [, second] = await Promise.all([
      state.switchActiveDisplay("display-2"),
      state.switchActiveDisplay("display-3"),
    ]);

    expect(second.activeDisplayId).toBe("display-3");
    expect(state.getSnapshot().activeDisplayId).toBe("display-3");
    expect(openDisplayOverlay).toHaveBeenLastCalledWith("display-3", undefined);
  });

  it("drops superseded clicks instead of walking through every one", async () => {
    const { state, openDisplayOverlay } = createThreeDisplayState();

    await Promise.all([
      state.switchActiveDisplay("display-2"),
      state.switchActiveDisplay("display-3"),
      state.switchActiveDisplay("display-1"),
    ]);

    expect(state.getSnapshot().activeDisplayId).toBe("display-1");
    // display-3 was superseded before it ever opened.
    const opened = openDisplayOverlay.mock.calls.map((call) => call[0]);
    expect(opened).not.toContain("display-3");
  });
});
