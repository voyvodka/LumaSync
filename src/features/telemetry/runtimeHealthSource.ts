/**
 * The capture stall and serial link budget, as Rust pushes them — the part of
 * telemetry the UI shows whether or not stats for nerds is on, so it must not
 * cost a poll. One listener per window for the app's lifetime, attached by the
 * first consumer; one `get_runtime_telemetry` read seeds it, because a worker
 * that published before this window listened (a WebView reload mid-stall) will
 * not publish again until something changes.
 */

import { useEffect } from "react";

import { parseCommandError } from "@/shared/contracts/status";
import {
  LINK_MAX_FPS_ABSENT,
  NO_RUNTIME_HEALTH_ISSUES,
  runtimeHealthFromSnapshot,
  type RuntimeHealth,
} from "@/shared/contracts/telemetry";
import { createStore, useStoreSelector } from "@/shared/lib/store";

import { listenRuntimeHealth, type UnlistenFn } from "./runtimeHealthEventsApi";
import { getFullTelemetrySnapshot } from "./telemetryApi";

const store = createStore<RuntimeHealth>(NO_RUNTIME_HEALTH_ISSUES);

let started = false;
/** Bumped by every pushed value, so a seed that resolves after one is dropped. */
let pushes = 0;
let unlisten: UnlistenFn | null = null;

function normalize(raw: RuntimeHealth): RuntimeHealth {
  return {
    captureFailureCode:
      typeof raw.captureFailureCode === "string" && raw.captureFailureCode.length > 0
        ? raw.captureFailureCode
        : null,
    linkConstrained: raw.linkConstrained === true,
    linkMaxFps:
      typeof raw.linkMaxFps === "number" && raw.linkMaxFps > 0 ? raw.linkMaxFps : LINK_MAX_FPS_ABSENT,
  };
}

function publish(next: RuntimeHealth): void {
  const current = store.get();
  if (
    current.captureFailureCode === next.captureFailureCode &&
    current.linkConstrained === next.linkConstrained &&
    current.linkMaxFps === next.linkMaxFps
  ) {
    return;
  }
  store.set(next);
}

function start(): void {
  if (started) return;
  started = true;

  const pushesBeforeSeed = pushes;
  // Chained off a resolved promise so a bridge that throws synchronously lands
  // in the same `catch` as one that rejects.
  Promise.resolve()
    .then(() =>
      listenRuntimeHealth((health) => {
        pushes += 1;
        publish(normalize(health));
      }),
    )
    .then((stop) => {
      if (started) {
        unlisten = stop;
      } else {
        stop();
      }
    })
    .catch((err: unknown) => {
      console.error("[LumaSync] runtime health listen failed:", err);
    });

  Promise.resolve()
    .then(() => getFullTelemetrySnapshot())
    .then((snapshot) => {
      if (!started || pushes !== pushesBeforeSeed) return;
      publish(runtimeHealthFromSnapshot(snapshot.usb));
    })
    .catch((raw: unknown) => {
      console.error("[LumaSync] runtime health seed failed:", parseCommandError(raw).message);
    });
}

/** The selected slice of the pushed runtime health. */
export function useRuntimeHealth<S>(
  selector: (health: RuntimeHealth) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  useEffect(() => {
    start();
  }, []);
  return useStoreSelector(store, selector, isEqual);
}

/** Test-only: drop the listener and the held value. */
export function __resetRuntimeHealthForTests(): void {
  unlisten?.();
  unlisten = null;
  started = false;
  pushes = 0;
  store.set(NO_RUNTIME_HEALTH_ISSUES);
}
