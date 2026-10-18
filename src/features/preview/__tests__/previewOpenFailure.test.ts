import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_STATUS, type PreviewSessionResult, type PreviewSessionStatusCode } from "@/shared/contracts/preview";

import { previewOpenFailure } from "../previewOpenFailure";

const answer = (code: PreviewSessionStatusCode): PreviewSessionResult => ({
  session: { state: "closed" },
  status: { code, message: code, details: null },
});

describe("previewOpenFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is no failure for an open, or a session already open", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(previewOpenFailure(answer(PREVIEW_STATUS.OPENED))).toBeNull();
    expect(previewOpenFailure(answer(PREVIEW_STATUS.ALREADY_OPEN))).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("is no failure when a close the user asked for lands during the open", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(previewOpenFailure(answer(PREVIEW_STATUS.CLOSED))).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports a failed open and logs it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(previewOpenFailure(answer(PREVIEW_STATUS.OPEN_FAILED))).toBe(PREVIEW_STATUS.OPEN_FAILED);
    expect(error).toHaveBeenCalledOnce();
  });
});
