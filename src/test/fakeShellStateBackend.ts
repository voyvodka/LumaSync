// An in-memory stand-in for `commands/shell_state.rs`, for tests that mock the
// Tauri boundary: the same merge, remove, revision and compare-and-swap rules,
// and the change event every window receives. The Rust side has its own tests;
// this one only has to agree with them.

import {
  SHELL_COMMANDS,
  SHELL_STATE_CHANGED_EVENT,
  type ShellStateChanged,
  type ShellStatePatchRequest,
  type ShellStateReplaceRequest,
  type ShellStateSnapshot,
  type ShellStateWriteResult,
} from "@/shared/contracts/shell";

type StateObject = Record<string, unknown>;
type EventHandler = (event: { event: string; payload: unknown }) => void;

export interface FakeShellStateBackend {
  /** The stored object, or `null` when nothing was ever written. */
  state(): StateObject | null;
  seed(state: StateObject | null): void;
  revision(): number;
  /** Every accepted patch, in order. */
  patches(): ShellStatePatchRequest[];
  replaces(): ShellStateReplaceRequest[];
  /** Answers a shell-state command; `undefined` for any other. */
  invoke(command: string, args?: unknown): Promise<unknown> | undefined;
  /** `listen` from `@tauri-apps/api/event`, for the change event. */
  listen(event: string, handler: EventHandler): Promise<() => void>;
  /** The next write rejects with `error` and changes nothing. */
  failNextWrite(error: unknown): void;
  /** Resolve each command on a later macrotask, so concurrent callers interleave. */
  useMacrotaskLatency(on: boolean): void;
}

export function createFakeShellStateBackend(initial: StateObject | null = null): FakeShellStateBackend {
  let state: StateObject | null = initial ? { ...initial } : null;
  let revision = 0;
  let pendingFailure: { error: unknown } | null = null;
  let macrotask = false;
  const patchLog: ShellStatePatchRequest[] = [];
  const replaceLog: ShellStateReplaceRequest[] = [];
  const handlers = new Set<EventHandler>();

  const settle = () =>
    macrotask ? new Promise<void>((resolve) => setTimeout(resolve, 0)) : Promise.resolve();

  const announce = (changed: ShellStateChanged) => {
    for (const handler of [...handlers]) {
      queueMicrotask(() => handler({ event: SHELL_STATE_CHANGED_EVENT, payload: changed }));
    }
  };

  const takeFailure = () => {
    const failure = pendingFailure;
    pendingFailure = null;
    if (failure) throw failure.error;
  };

  const patch = (request: ShellStatePatchRequest): ShellStateWriteResult => {
    takeFailure();
    const next: StateObject = { ...(state ?? {}), ...request.set };
    for (const key of request.remove) delete next[key];
    state = next;
    revision += 1;
    patchLog.push(request);
    announce({
      set: request.set,
      remove: [...request.remove],
      revision,
      writerId: request.writerId ?? null,
    });
    return { applied: true, revision };
  };

  const replace = (request: ShellStateReplaceRequest): ShellStateWriteResult => {
    if (request.expectedRevision !== revision) return { applied: false, revision };
    takeFailure();
    const previous = state ?? {};
    const next = request.state as unknown as StateObject;
    const set = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value)),
    );
    const remove = Object.keys(previous).filter((key) => !(key in next));
    state = { ...next };
    revision += 1;
    replaceLog.push(request);
    announce({ set, remove, revision, writerId: request.writerId ?? null });
    return { applied: true, revision };
  };

  return {
    state: () => (state ? { ...state } : null),
    seed(next) {
      state = next ? { ...next } : null;
    },
    revision: () => revision,
    patches: () => [...patchLog],
    replaces: () => [...replaceLog],
    invoke(command, args) {
      const payload = (args ?? {}) as { patch?: ShellStatePatchRequest; request?: ShellStateReplaceRequest };
      switch (command) {
        case SHELL_COMMANDS.GET_SHELL_STATE:
          return settle().then<ShellStateSnapshot>(() => ({
            state: state ? { ...state } : null,
            revision,
          }));
        case SHELL_COMMANDS.PATCH_SHELL_STATE:
          // JSON, as `invoke` sends it: an `undefined` value never arrives.
          return settle().then(() => patch(JSON.parse(JSON.stringify(payload.patch))));
        case SHELL_COMMANDS.REPLACE_SHELL_STATE:
          return settle().then(() => replace(JSON.parse(JSON.stringify(payload.request))));
        default:
          return undefined;
      }
    },
    listen(event, handler) {
      if (event === SHELL_STATE_CHANGED_EVENT) handlers.add(handler);
      return Promise.resolve(() => {
        handlers.delete(handler);
      });
    },
    failNextWrite(error) {
      pendingFailure = { error };
    },
    useMacrotaskLatency(on) {
      macrotask = on;
    },
  };
}
