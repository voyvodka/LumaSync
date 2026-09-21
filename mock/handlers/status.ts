/**
 * Builds the coded-status envelope every never-throwing command carries.
 *
 * Written once here because `CommandStatusOf` requires `message` and `details`
 * on the wire — `details` is a Rust `Option<String>` with no
 * `skip_serializing_if`, so it is `null`, never absent. A fixture that returns
 * `{ code }` alone is not the shape the app parses.
 */
export function status<T extends string>(
  code: T,
  message: string,
  details: string | null = null,
): { code: T; message: string; details: string | null } {
  return { code, message, details };
}
