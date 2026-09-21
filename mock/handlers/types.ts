/** A fixture. Reads the world, may mutate it, returns what Rust would return. */
export type Handler = (args?: Record<string, unknown>) => unknown;
