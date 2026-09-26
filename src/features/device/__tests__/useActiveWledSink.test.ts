import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";
import type { getWledSinkStatus } from "../wledApi";

const loadMock = vi.fn<typeof shellStoreType.load>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => loadMock(),
    save: vi.fn<typeof shellStoreType.save>(),
  },
}));

import { useActiveWledSink } from "../useWledSink";

describe("useActiveWledSink", () => {
  // A default dependency rebuilt per render re-ran the refresh effect on every
  // render of App, reading the shell state and the sink status each time.
  it("reads the sink once on mount, not again on every render", async () => {
    loadMock.mockResolvedValue({} as Awaited<ReturnType<typeof shellStoreType.load>>);
    const getStatus = vi.fn<typeof getWledSinkStatus>().mockResolvedValue({ sink: null } as Awaited<ReturnType<typeof getWledSinkStatus>>);

    const { rerender } = renderHook(() => useActiveWledSink({ getStatus }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    rerender();
    rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});
