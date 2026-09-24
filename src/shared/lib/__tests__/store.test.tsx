import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createStore, shallowEqual, useMirroredStore, useStoreSelector, type Store } from "../store";

describe("createStore", () => {
  it("notifies on a new value and stays quiet on the same one", () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const same = store.get();
    store.set(same);
    expect(listener).not.toHaveBeenCalled();

    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ n: 2 });

    unsubscribe();
    store.set({ n: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("shallowEqual", () => {
  it("compares one level deep", () => {
    const inner = { a: 1 };
    expect(shallowEqual({ x: inner, y: 1 }, { x: inner, y: 1 })).toBe(true);
    expect(shallowEqual({ x: inner }, { x: { a: 1 } })).toBe(false);
    expect(shallowEqual({ x: 1 }, { x: 1, y: undefined })).toBe(false);
    expect(shallowEqual({ x: 1, y: undefined }, { x: 1, z: undefined })).toBe(false);
    expect(shallowEqual<unknown>(null, {})).toBe(false);
    expect(shallowEqual(2, 2)).toBe(true);
  });
});

describe("useStoreSelector", () => {
  function Reader({
    store,
    renders,
  }: {
    store: Store<{ a: number; b: number }>;
    renders: { count: number };
  }) {
    renders.count += 1;
    const a = useStoreSelector(store, (state) => state.a);
    const pair = useStoreSelector(store, (state) => ({ a: state.a }), shallowEqual);
    return (
      <p data-testid="value">
        {a}:{pair.a}
      </p>
    );
  }

  it("re-renders only when the selected slice changes", () => {
    const store = createStore({ a: 1, b: 1 });
    const renders = { count: 0 };
    render(<Reader store={store} renders={renders} />);
    const initial = renders.count;

    act(() => store.set({ a: 1, b: 2 }));
    expect(renders.count).toBe(initial);

    act(() => store.set({ a: 5, b: 2 }));
    expect(renders.count).toBe(initial + 1);
    expect(screen.getByTestId("value")).toHaveTextContent("5:5");
  });
});

describe("useMirroredStore", () => {
  it("is seeded with the first value and follows later ones after commit", () => {
    const seen: number[] = [];
    let mirrored: Store<{ n: number }> | null = null;
    function Mirror({ n }: { n: number }) {
      mirrored = useMirroredStore({ n });
      return null;
    }

    const { rerender } = render(<Mirror n={1} />);
    const store = mirrored as unknown as Store<{ n: number }>;
    expect(store.get()).toEqual({ n: 1 });
    store.subscribe(() => seen.push(store.get().n));

    rerender(<Mirror n={1} />);
    expect(seen).toEqual([]);

    rerender(<Mirror n={2} />);
    expect(seen).toEqual([2]);
    expect(mirrored).toBe(store);
  });
});
