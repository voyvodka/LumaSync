import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetWindowVisibilityForTests } from "@/features/shell/windowVisibility";
import type { MainWindowVisibility } from "@/shared/contracts/shell";

import {
  __resetHueHealthStoreForTests,
  getHueHealthState,
  refreshHueHealth,
  retryHueHealthProbe,
  subscribeHueHealth,
  watchHueAreaReadiness,
} from "../hueHealthStore";
import {
  sameJson,
  selectHueBridgeHealth,
  selectHueStreamState,
  useHueHealth,
} from "../useHueHealth";
import {
  currentHealth,
  fakeHueHealthApi,
  publishHealth,
  resetHealth,
  runtimeStatus,
} from "../../__tests__/fakeHueHealth";

vi.mock("../../hueHealthApi", async () => (await import("../../__tests__/fakeHueHealth")).fakeHueHealthApi);

let pushWindowVisibility: ((visibility: MainWindowVisibility) => void) | null = null;
vi.mock("@/features/shell/windowVisibilityApi", () => ({
  getMainWindowVisibility: () => Promise.resolve({ visible: true }),
}));
vi.mock("@/features/shell/windowVisibilityEventsApi", () => ({
  listenMainWindowVisibility: (handler: (visibility: MainWindowVisibility) => void) => {
    pushWindowVisibility = handler;
    return Promise.resolve(() => {
      pushWindowVisibility = null;
    });
  },
}));

let visibility: DocumentVisibilityState = "visible";

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

const declared = () => fakeHueHealthApi.watchHueHealth.mock.calls.map(([watch]) => watch);
const lastDeclared = () => declared()[declared().length - 1];

describe("hueHealthStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    __resetWindowVisibilityForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("declares a visible window on the first subscriber and releases on the last", async () => {
    const first = subscribeHueHealth(() => {});
    const second = subscribeHueHealth(() => {});
    await flush();

    expect(declared()).toEqual([{ visible: true, areaReadiness: false }]);
    expect(fakeHueHealthApi.listenHueHealth).toHaveBeenCalledOnce();
    expect(getHueHealthState().snapshot).toEqual(currentHealth());

    first();
    await flush();
    expect(declared()).toHaveLength(1);

    second();
    await flush();
    expect(lastDeclared()).toEqual({ visible: false, areaReadiness: false });
    expect(getHueHealthState().snapshot).toBeNull();
  });

  it("never polls: ten minutes of an idle subscription cost one declaration", async () => {
    const release = subscribeHueHealth(() => {});
    await flush(600_000);

    expect(fakeHueHealthApi.watchHueHealth).toHaveBeenCalledOnce();
    expect(fakeHueHealthApi.getHueHealth).not.toHaveBeenCalled();
    release();
  });

  it("tells Rust when the window hides and shows", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();

    setVisibility("hidden");
    await flush();
    setVisibility("visible");
    await flush();

    expect(declared()).toEqual([
      { visible: true, areaReadiness: false },
      { visible: false, areaReadiness: false },
      { visible: true, areaReadiness: false },
    ]);
    release();
  });

  it("declares the window hidden when Rust says so, though the document reads visible", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();
    expect(pushWindowVisibility).not.toBeNull();

    pushWindowVisibility?.({ visible: false });
    await flush();
    expect(document.visibilityState).toBe("visible");
    expect(lastDeclared()).toEqual({ visible: false, areaReadiness: false });

    pushWindowVisibility?.({ visible: true });
    await flush();
    expect(declared()).toEqual([
      { visible: true, areaReadiness: false },
      { visible: false, areaReadiness: false },
      { visible: true, areaReadiness: false },
    ]);
    release();
  });

  it("asks for the area only while a view watches it, and says so while hidden too", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();

    const stopA = watchHueAreaReadiness();
    const stopB = watchHueAreaReadiness();
    await flush();
    expect(lastDeclared()).toEqual({ visible: true, areaReadiness: true });
    expect(declared()).toHaveLength(2);

    // Rust tells the view mounting from the window showing again by this flag.
    setVisibility("hidden");
    await flush();
    expect(lastDeclared()).toEqual({ visible: false, areaReadiness: true });
    setVisibility("visible");
    await flush();

    stopA();
    stopA();
    await flush();
    expect(lastDeclared()).toEqual({ visible: true, areaReadiness: true });
    stopB();
    await flush();
    expect(lastDeclared()).toEqual({ visible: true, areaReadiness: false });
    release();
  });

  it("keeps the newest revision whichever order they arrive in", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();
    const seed = getHueHealthState().snapshot!;

    let newer = currentHealth();
    act(() => {
      newer = publishHealth({ stream: { active: true, status: runtimeStatus("Running") } });
    });
    await flush();
    expect(getHueHealthState().snapshot?.revision).toBe(newer.revision);

    // A late answer carrying the older revision is dropped.
    fakeHueHealthApi.getHueHealth.mockResolvedValueOnce(seed);
    await act(async () => {
      await refreshHueHealth();
    });
    expect(getHueHealthState().snapshot?.stream.status.state).toBe("Running");
    release();
  });

  it("holds a rejected read beside the last snapshot and retries it on a backoff", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();
    const held = getHueHealthState().snapshot;

    fakeHueHealthApi.getHueHealth.mockRejectedValueOnce(new Error("ipc down"));
    fakeHueHealthApi.watchHueHealth.mockRejectedValueOnce(new Error("ipc down"));
    await act(async () => {
      await refreshHueHealth();
    });
    expect(getHueHealthState().readFailure?.code).toBe("HUE_STREAM_STATUS_UNAVAILABLE");
    expect(getHueHealthState().snapshot).toBe(held);

    const calls = fakeHueHealthApi.watchHueHealth.mock.calls.length;
    await flush(2_000);
    expect(fakeHueHealthApi.watchHueHealth.mock.calls.length).toBe(calls + 1);
    expect(getHueHealthState().readFailure?.code).toBe("HUE_STREAM_STATUS_UNAVAILABLE");

    await flush(4_000);
    expect(fakeHueHealthApi.watchHueHealth.mock.calls.length).toBe(calls + 2);
    expect(getHueHealthState().readFailure).toBeNull();
    release();
  });

  it("sends the manual retry to Rust and takes its answer", async () => {
    const release = subscribeHueHealth(() => {});
    await flush();

    retryHueHealthProbe();
    await flush();

    expect(fakeHueHealthApi.retryHueHealth).toHaveBeenCalledOnce();
    release();
  });
});

describe("useHueHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth();
    visibility = "visible";
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
  });

  it("re-renders a consumer only when the slice it reads changes", async () => {
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useHueHealth(selectHueStreamState);
    });
    await flush();
    const settled = renders;
    expect(view.result.current).toBe("Idle");

    act(() => {
      publishHealth({ bridge: { probing: true } });
    });
    await flush();
    act(() => {
      publishHealth({ bridge: { probing: false, verdict: "unreachable" } });
    });
    await flush();
    expect(renders).toBe(settled);

    act(() => {
      publishHealth({ stream: { active: true, status: runtimeStatus("Running") } });
    });
    await flush();
    expect(renders).toBe(settled + 1);
    expect(view.result.current).toBe("Running");
  });

  it("compares an object slice by value, not by the parsed object", async () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useHueHealth(selectHueBridgeHealth, sameJson);
    });
    await flush();
    const settled = renders;

    act(() => {
      publishHealth({ stream: { status: runtimeStatus("Idle", "HUE_STREAM_STOPPED") } });
    });
    await flush();
    expect(renders).toBe(settled);

    act(() => {
      publishHealth({ bridge: { gaveUp: true } });
    });
    await flush();
    expect(renders).toBe(settled + 1);
  });
});
