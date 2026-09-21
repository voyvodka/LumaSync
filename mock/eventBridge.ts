/**
 * The browser-side event plugin, replacing `mockIPC`'s built-in one.
 *
 * `@tauri-apps/api/mocks` ships an event registry behind `shouldMockEvents`,
 * and it cannot unsubscribe. `_unlisten` sends `{ event, eventId }`
 * (`event.js:42`) while the mock's remover reads `args.id`
 * (`mocks.js:120`), so `indexOf(undefined)` is always `-1` and the entry is
 * never spliced out. Nothing fails loudly: the callback itself *was*
 * unregistered, so every later emit reaches a dead id and logs
 * `[TAURI] Couldn't find callback id …`.
 *
 * At 10 Hz with a component that mounts and unmounts — the edge grid, which
 * subscribes only while Ambilight is on — that is hundreds of warnings a
 * second into the console, which is the surface you are reading while
 * debugging. The registry also grows without bound for as long as the tab
 * lives.
 *
 * So the plugin is owned here instead. `plugin:event|*` stays out of
 * `pluginHandlers` on purpose: under `tauri dev` those calls must reach Rust,
 * and this bridge is only installed on the browser branch in `boot.ts`.
 */

interface EventInternals {
  runCallback?: (id: number, data: unknown) => void;
}

/** event name → the callback ids currently subscribed to it. */
const listeners = new Map<string, number[]>();

const EVENT_PLUGIN_PREFIX = "plugin:event|";

export function isEventPluginCommand(command: string): boolean {
  return command.startsWith(EVENT_PLUGIN_PREFIX);
}

/** Visible for tests; also what the panel reads to show subscriber counts. */
export function listenerCount(event: string): number {
  return listeners.get(event)?.length ?? 0;
}

export function resetEventBridge(): void {
  listeners.clear();
}

function runCallback(id: number, data: unknown): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: EventInternals })
    .__TAURI_INTERNALS__;
  internals?.runCallback?.(id, data);
}

/**
 * Returns `undefined` for anything that is not an event-plugin command, so the
 * caller can fall through to the fixture table. `null` is a real answer here —
 * `emit` and `unlisten` both resolve to it.
 */
export function handleEventPluginCommand(
  command: string,
  args: Record<string, unknown> | undefined,
): unknown {
  const event = typeof args?.event === "string" ? args.event : "";

  switch (command) {
    case `${EVENT_PLUGIN_PREFIX}listen`: {
      const handler = args?.handler;
      if (typeof handler !== "number") return null;
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
      // The id the caller gets back is what it will hand to `unlisten`.
      return handler;
    }

    case `${EVENT_PLUGIN_PREFIX}unlisten`: {
      const eventId = args?.eventId;
      const current = listeners.get(event);
      if (current === undefined || typeof eventId !== "number") return null;
      const index = current.indexOf(eventId);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) listeners.delete(event);
      return null;
    }

    case `${EVENT_PLUGIN_PREFIX}emit`:
    case `${EVENT_PLUGIN_PREFIX}emit_to`: {
      // Copied before iterating: a handler that unsubscribes itself while the
      // loop is running would otherwise shift the array under it and skip the
      // next subscriber.
      for (const id of [...(listeners.get(event) ?? [])]) {
        runCallback(id, { event, id, payload: args?.payload });
      }
      return null;
    }

    default:
      // A future method of the event plugin. Answering `null` would look like
      // success; naming it is how it gets noticed.
      return undefined;
  }
}
