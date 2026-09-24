import type {
  CommandArgsTuple,
  CommandName,
  CommandResult,
} from "../../src/shared/contracts/ipc";

/** A fixture. Reads the world, may mutate it, returns what Rust would return. */
export type Handler = (args?: Record<string, unknown>) => unknown;

/**
 * A handler map bound to the real command map (`src/shared/contracts/ipc.ts`),
 * the same table `invokeCommand` and the test helpers are typed from. Applied
 * with `satisfies` so the object keeps its literal keys for the exhaustiveness
 * guard in `index.ts` while every handler is checked on both halves of the
 * wire: it must accept exactly what the bridge sends, and return what Rust
 * returns.
 *
 * Both halves were bugs before they were types. Fixtures written from command
 * names answered with shapes the backend cannot produce — six of twelve Hue
 * handlers, two invented status codes, a telemetry payload with every field
 * misnamed — and surfaced three screens away as an empty panel. And
 * `set_lighting_mode`'s fixture read `args.mode` for the whole life of the mock
 * while the bridge only ever sent `{ payload }`, so Solid mode was unreachable
 * through it.
 */
export type TypedHandlers = {
  [K in CommandName]?: (...args: CommandArgsTuple<K>) => CommandResult<K>;
};
