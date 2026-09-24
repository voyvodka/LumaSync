import { Suspense, useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { preloadableComponent } from "../preloadableComponent";

function Greeting({ name }: { name: string }) {
  return <p>hello {name}</p>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("preloadableComponent", () => {
  it("shows the fallback until the chunk arrives, then renders with its props", async () => {
    const chunk = deferred<typeof Greeting>();
    const Lazy = preloadableComponent("Greeting", () => chunk.promise);

    render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy.Component name="amber" />
      </Suspense>,
    );
    expect(screen.getByText("loading")).toBeInTheDocument();

    await act(async () => {
      chunk.resolve(Greeting);
    });
    expect(screen.getByText("hello amber")).toBeInTheDocument();
  });

  it("renders a preloaded chunk on the first pass, without the fallback", async () => {
    const load = vi.fn(() => Promise.resolve(Greeting));
    const Lazy = preloadableComponent("Greeting", load);

    Lazy.preload();
    Lazy.preload();
    await act(async () => {});

    render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy.Component name="amber" />
      </Suspense>,
    );
    expect(screen.queryByText("loading")).not.toBeInTheDocument();
    expect(screen.getByText("hello amber")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not remount an instance that mounted before the chunk arrived", async () => {
    const mounts = vi.fn();
    function Counter({ label }: { label: string }) {
      useEffect(() => mounts(), []);
      return <p>{label}</p>;
    }
    const chunk = deferred<typeof Counter>();
    const Lazy = preloadableComponent("Counter", () => chunk.promise);
    // An already-visible boundary, as in the settings panel: a section switch
    // suspends inside it rather than mounting a fresh one.
    const tree = (label: string | null) => (
      <Suspense fallback={<p>loading</p>}>
        {label === null ? <p>previous section</p> : <Lazy.Component label={label} />}
      </Suspense>
    );

    const { rerender } = render(tree(null));
    rerender(tree("first"));
    await act(async () => {
      chunk.resolve(Counter);
    });
    rerender(tree("second"));

    expect(screen.getByText("second")).toBeInTheDocument();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("logs a failed preload instead of leaving an unhandled rejection", async () => {
    const error = new Error("chunk missing");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const Lazy = preloadableComponent("Broken", () => Promise.reject(error));

    Lazy.preload();
    await act(async () => {});

    expect(consoleError).toHaveBeenCalledWith("[LumaSync] preloading the Broken chunk failed:", error);
    consoleError.mockRestore();
  });
});
