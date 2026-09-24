/** Joins class names, dropping empty and falsy entries: `cx("lm-row", nested && "is-nested")`. */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
