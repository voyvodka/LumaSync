import type { CommandArgs } from "./args";
import type { CommandResponse } from "./responses";

/** A fixture. Reads the world, may mutate it, returns what Rust would return. */
export type Handler = (args?: Record<string, unknown>) => unknown;

/**
 * A handler map bound to the real response types. Applied with `satisfies` so
 * the object keeps its literal keys for the exhaustiveness guard while every
 * return value is checked against what the backend actually produces.
 *
 * This is the whole defence against the failure that produced this file: a
 * fixture written from the command name rather than the DTO now fails
 * `typecheck:mock` instead of surfacing as an empty panel three screens away.
 *
 * The argument side is bound the same way, through `CommandArgs` (`args.ts`):
 * a command declared there requires its handler to accept the real payload
 * shape instead of an untyped `Record<string, unknown>`, so a handler that
 * destructures a field the bridge never sends — the `args.mode` /
 * `{ payload }` mismatch this pairing was added to catch — fails here too.
 * Only commands with a non-empty real payload are in `CommandArgs`; anything
 * else keeps the untyped fallback.
 */
export type TypedHandlers = {
  [K in keyof CommandResponse]?: K extends keyof CommandArgs
    ? (args: CommandArgs[K]) => CommandResponse[K]
    : (args?: Record<string, unknown>) => CommandResponse[K];
};
