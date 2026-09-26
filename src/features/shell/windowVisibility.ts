/**
 * Whether the main window is on screen: the document says visible *and* Rust
 * says the native window is shown and not minimised. WebView2 can keep
 * `document.visibilityState` at "visible" while the window sits hidden in the
 * tray, so a background poll that trusted the document alone kept running for
 * nobody. See docs/architecture/ui-and-shell.md, "Background polls are
 * visibility-aware".
 *
 * Main window only: Rust reports the main window, and emits only to it.
 */

import { useSyncExternalStore } from "react";

import { parseCommandError } from "@/shared/contracts/status";

import { getMainWindowVisibility } from "./windowVisibilityApi";
import { listenMainWindowVisibility, type UnlistenFn } from "./windowVisibilityEventsApi";

// Visible until Rust answers: a signal that never arrives must leave the
// document as the only judge, as before, not stop every poll for good.
let nativeVisible = true;
/** Bumped by every start and stop, so a stale listen or read is dropped. */
let session = 0;
/** Bumped by every pushed value, so a read that resolves after one is dropped. */
let pushes = 0;
let unlisten: UnlistenFn | null = null;
/** Set by `pagehide`, which fires before the unload's `visibilitychange`. */
let unloading = false;

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** The combined answer, read live — safe to call with no subscriber. */
export function isWindowVisible(): boolean {
  return documentVisible() && nativeVisible;
}

const listeners = new Set<(visible: boolean) => void>();
let lastPublished = isWindowVisible();

/** `force` re-announces an unchanged answer. The document is read live, so a
 * consumer may have paused on a hidden document this store never saw change;
 * a `visibilitychange` back to visible must still reach it. */
function recompute(force = false): void {
  const visible = isWindowVisible();
  if (!force && visible === lastPublished) return;
  lastPublished = visible;
  for (const listener of [...listeners]) listener(visible);
}

function ask(): void {
  const mine = session;
  const pushesBefore = pushes;
  // Chained off a resolved promise so a bridge that throws synchronously lands
  // in the same `catch` as one that rejects.
  Promise.resolve()
    .then(() => getMainWindowVisibility())
    .then(({ visible }) => {
      if (mine !== session || pushes !== pushesBefore) return;
      nativeVisible = visible;
      recompute();
    })
    .catch((error: unknown) => {
      console.warn("[LumaSync] window visibility read failed:", parseCommandError(error).message);
    });
}

// A `show()` the frontend makes itself (the boot show) reaches Rust as no
// event, but the document becoming visible or focused asks Rust again.
function onDocumentVisibility(): void {
  // A reload hides the document on its way out; announcing that sends IPC the
  // page is gone before it answers (a cancelled fetch and an orphaned callback).
  if (unloading) return;
  recompute(true);
  if (documentVisible()) ask();
}

function onFocus(): void {
  ask();
}

function onPageHide(): void {
  unloading = true;
}

function onPageShow(): void {
  unloading = false;
}

function start(): void {
  session += 1;
  const mine = session;
  Promise.resolve()
    .then(() =>
      listenMainWindowVisibility(({ visible }) => {
        if (mine !== session) return;
        pushes += 1;
        nativeVisible = visible;
        recompute();
      }),
    )
    .then((stop) => {
      if (mine === session) unlisten = stop;
      else stop();
    })
    .catch((error: unknown) => {
      console.error("[LumaSync] window visibility listen failed:", error);
    });
  document.addEventListener("visibilitychange", onDocumentVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  recompute();
  ask();
}

function stop(): void {
  session += 1;
  unlisten?.();
  unlisten = null;
  document.removeEventListener("visibilitychange", onDocumentVisibility);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
  unloading = false;
  nativeVisible = true;
  lastPublished = isWindowVisible();
}

/**
 * Calls `listener` with the combined answer each time it changes. The first
 * subscriber starts listening to Rust and the last one stops it.
 */
export function subscribeWindowVisible(listener: (visible: boolean) => void): () => void {
  // Its own entry, so one function subscribed twice is released twice.
  const entry = (visible: boolean) => listener(visible);
  listeners.add(entry);
  if (listeners.size === 1) start();
  return () => {
    if (!listeners.delete(entry)) return;
    if (listeners.size === 0) stop();
  };
}

function subscribeForReact(onChange: () => void): () => void {
  return subscribeWindowVisible(() => onChange());
}

/** Whether the main window is on screen, re-rendering when that changes. */
export function useWindowVisible(): boolean {
  return useSyncExternalStore(subscribeForReact, isWindowVisible, isWindowVisible);
}

/** Test-only: drop every subscriber and forget what Rust said. */
export function __resetWindowVisibilityForTests(): void {
  listeners.clear();
  pushes = 0;
  stop();
}
