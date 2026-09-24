import { createElement, lazy, useState, type ComponentType } from "react";

export interface PreloadableComponent<P extends object> {
  /** Suspends until the chunk is loaded; render it inside a `<Suspense>`. */
  Component: ComponentType<P>;
  /** Starts the chunk download without rendering. Idempotent. */
  preload: () => void;
}

/**
 * `React.lazy` with a preload handle.
 *
 * A fresh `lazy` suspends on its first render even when its chunk is already
 * in, which commits the fallback for a frame. So an instance mounted after the
 * chunk arrived renders the loaded component directly. The choice is held in
 * state so an instance can never change element type mid-life, which would
 * remount the section and drop its state.
 */
export function preloadableComponent<P extends object>(
  name: string,
  load: () => Promise<ComponentType<P>>,
): PreloadableComponent<P> {
  let pending: Promise<ComponentType<P>> | null = null;
  let loaded: ComponentType<P> | null = null;

  const start = (): Promise<ComponentType<P>> => {
    if (pending === null) {
      pending = load().then((component) => {
        loaded = component;
        return component;
      });
    }
    return pending;
  };

  const Lazy = lazy(() => start().then((component) => ({ default: component })));

  function Preloadable(props: P) {
    const [Loaded] = useState(() => loaded);
    return createElement(Loaded ?? Lazy, props);
  }
  Preloadable.displayName = `Preloadable(${name})`;

  return {
    Component: Preloadable,
    preload: () => {
      void start().catch((err: unknown) => {
        console.error(`[LumaSync] preloading the ${name} chunk failed:`, err);
      });
    },
  };
}
