/** Coded-status envelope shared by every never-throwing command. `TCode` is the
 *  wire union — never `string`, never `X | string`. See contracts-and-state.md. */
export interface CommandStatusOf<TCode extends string> {
  code: TCode;
  message: string;
  /** Rust `Option<String>`, no `skip_serializing_if` — `null` on the wire, never absent. */
  details: string | null;
}

/** A command rejection, read once. `code` is not narrowed to any union: the
 *  caller decides which codes it can handle.
 *
 *  `message` and `details` are raw backend text and can carry a bridge's
 *  response body. Render them as a text node only — never as a `<Trans>`
 *  value, since i18n runs with `escapeValue: false`. */
export interface ParsedCommandError {
  /** The leading `UPPER_SNAKE` code, or `null` when the text carries none. */
  code: string | null;
  /** The whole rejection text — what the log needs. */
  message: string;
  /** What followed the code; `null` for a bare code or uncoded text. */
  details: string | null;
}

const UNREADABLE_REJECTION = "Command rejected with no readable message";

// `"CODE: context"`, or the code alone. Some Err arms carry it as a prefix.
const CODED_TEXT = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,})\s*(?::\s*([\s\S]*))?$/;

function parseText(raw: string): ParsedCommandError {
  const message = raw.trim();
  const match = CODED_TEXT.exec(message);
  if (!match) return { code: null, message, details: null };
  const details = match[2]?.trim();
  return { code: match[1] ?? null, message, details: details ? details : null };
}

/** Read any rejection — a `Result<_, String>` command's bare string (by
 *  convention `"CODE: context"`), an `Error`, or a structured
 *  `{ code, message, details }` — into one shape. Transport failures carry
 *  `error.message` and nothing else — never an object that holds credentials,
 *  so an object with no `message` is not serialised. */
export function parseCommandError(error: unknown): ParsedCommandError {
  if (typeof error === "string") return parseText(error);
  if (error instanceof Error) return parseText(error.message);
  if (error !== null && typeof error === "object") {
    const data = error as Record<string, unknown>;
    const parsed = parseText(typeof data.message === "string" ? data.message : UNREADABLE_REJECTION);
    return {
      code: typeof data.code === "string" ? data.code : parsed.code,
      message: parsed.message,
      details: typeof data.details === "string" ? data.details : parsed.details,
    };
  }
  if (error === null || error === undefined) return parseText(UNREADABLE_REJECTION);
  return parseText(String(error));
}
