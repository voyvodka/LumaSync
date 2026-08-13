/** Coded-status envelope shared by every never-throwing command. `TCode` is the
 *  wire union — never `string`, never `X | string`. See contracts-and-state.md. */
export interface CommandStatusOf<TCode extends string> {
  code: TCode;
  message: string;
  /** Rust `Option<String>`, no `skip_serializing_if` — `null` on the wire, never absent. */
  details: string | null;
}
