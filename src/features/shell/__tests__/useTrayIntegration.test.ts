import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTrayIntegration } from "../useTrayIntegration";

type Listener = () => void;
let previewListener: Listener | undefined;
const unlisten = vi.fn();
const listenTrayShowLedPreview = vi.fn((cb: Listener) => {
  previewListener = cb;
  return Promise.resolve(unlisten);
});

// Only the preview item is a window event. The lighting items (off, resume,
// solid) run the transaction in Rust, so no window listens for them.
vi.mock("@/features/tray/trayController", () => ({
  listenTrayShowLedPreview: (cb: Listener) => listenTrayShowLedPreview(cb),
}));

vi.mock("@/features/tray/trayApi", () => ({
  updateTrayLabels: () => Promise.resolve(),
}));

vi.mock("../windowLifecycle", () => ({
  loadShellState: () => Promise.resolve({}),
  saveShellState: () => Promise.resolve(),
}));

vi.mock("@/features/preview/previewApi", () => ({
  openLedControlPopup: () => Promise.resolve(),
  showLedControlPopup: () => Promise.resolve(),
  openLedTwinOverlay: () => Promise.resolve(),
}));

describe("useTrayIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewListener = undefined;
  });

  it("listens for the preview item and nothing else", async () => {
    renderHook(() => useTrayIntegration({}));

    await waitFor(() => expect(previewListener).toBeDefined());
    expect(listenTrayShowLedPreview).toHaveBeenCalledOnce();
  });

  it("removes its listener on unmount", async () => {
    const view = renderHook(() => useTrayIntegration({}));
    await waitFor(() => expect(previewListener).toBeDefined());

    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
