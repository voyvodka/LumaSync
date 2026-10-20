import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir` whose name `match` accepts, in directory order. `node_modules` and the
 *  directories named in `skip` are not entered. */
export function walkFiles(dir, match = () => true, skip = []) {
  const skipped = new Set(["node_modules", ...skip]);
  const out = [];
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        if (!skipped.has(name)) visit(full);
      } else if (match(name)) {
        out.push(full);
      }
    }
  };
  visit(dir);
  return out;
}

const LINE_COMMENT = /(^|[^:"'`])\/\/[^\n]*/g;

/** Source with its comments removed. A `//` after `:`, a quote or a backtick is kept — a URL or a
 *  string, not a comment. */
export const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(LINE_COMMENT, "$1");

/** As `stripComments`, but a block comment leaves its newlines, so line numbers still match the file. */
export const stripCommentsKeepingLines = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => "\n".repeat((comment.match(/\n/g) ?? []).length))
    .replace(LINE_COMMENT, "$1");
