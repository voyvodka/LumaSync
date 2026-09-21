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
 */
export type TypedHandlers = {
  [K in keyof CommandResponse]?: (args?: Record<string, unknown>) => CommandResponse[K];
};
