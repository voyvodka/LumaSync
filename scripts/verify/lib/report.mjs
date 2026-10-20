/**
 * The ✔ / ✘ lines a verifier prints and the failure count its summary reads. Each script keeps its
 * own heading and summary wording; only the per-check lines are shared.
 */
export function createReport() {
  const report = {
    failures: 0,
    pass(message) {
      console.log(`  ✔  ${message}`);
    },
    fail(message) {
      report.failures += 1;
      console.log(`  ✘  ${message}`);
    },
    check(ok, passMessage, failMessage) {
      if (ok) report.pass(passMessage);
      else report.fail(failMessage);
    },
  };
  return report;
}
