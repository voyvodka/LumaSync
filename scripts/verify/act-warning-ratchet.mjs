// A vitest reporter that counts React's "not wrapped in act(...)" warnings and
// fails the run when there are more than `act-warning-baseline.txt` allows.
// Each one is a state update the test never waited for — an assertion that can
// pass before the component settles. The baseline may only shrink.
//
// A count below the baseline is reported, not failed: a partial run
// (`bun run test <file>`) always sees fewer, and this runs inside a required CI
// check, where a timing-dependent miss must not turn a PR red. Lower the file
// by hand when the notice appears on a full run.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(here, "act-warning-baseline.txt");
const MARKER = "not wrapped in act(";

function readBaseline() {
  const line = readFileSync(BASELINE_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  const value = Number(line);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${BASELINE_FILE} must hold one non-negative integer, got ${JSON.stringify(line)}`);
  }
  return value;
}

export default class ActWarningRatchet {
  count = 0;
  byFile = new Map();

  onInit(vitest) {
    this.vitest = vitest;
  }

  onUserConsoleLog(log) {
    if (log.type !== "stderr") return;
    const hits = log.content.split(MARKER).length - 1;
    if (hits === 0) return;
    this.count += hits;
    const file = this.vitest?.state.idMap.get(log.taskId ?? "")?.file?.filepath ?? "(unattributed)";
    const key = file.startsWith("/") ? relative(process.cwd(), file) : file;
    this.byFile.set(key, (this.byFile.get(key) ?? 0) + hits);
  }

  onTestRunEnd(_modules, _errors, reason) {
    if (reason === "interrupted") return;
    const baseline = readBaseline();
    const summary = `act() warnings: ${this.count} (baseline ${baseline})`;

    if (this.count > baseline) {
      console.error(`\n${summary} — the count may only shrink. Warnings by file:`);
      for (const [file, n] of [...this.byFile].sort((a, b) => b[1] - a[1])) {
        console.error(`  ${n}  ${file}`);
      }
      process.exitCode = 1;
    } else if (this.count < baseline) {
      const hint = `If this was the full suite, lower scripts/verify/act-warning-baseline.txt to ${this.count}.`;
      console.log(`\n${summary}. ${hint}`);
      if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice::${summary}. ${hint}`);
    } else {
      console.log(`\n${summary}`);
    }
  }
}
