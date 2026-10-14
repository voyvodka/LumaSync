#!/usr/bin/env node
/**
 * Phase 01 Shell Contracts Verifier
 *
 * Fails (exit 1) if required exports, section IDs, error codes, or
 * command strings drift across `src/shared/contracts/*.ts`.
 *
 * Green means DECLARED, not sound: no grep can tell you a code sits in the right
 * union, is wired to a result type, or is handled by any consumer.
 *
 * The check count is not a coverage score: derived Rust parity covers one emit
 * surface of roughly seven, and the PORT block four codes of one file.
 *
 * The checks live by domain in `contracts/`; each module runs its checks when it is imported, so
 * the order below is the order they print in.
 *
 * Usage: node scripts/verify/phase01-shell-contracts.mjs
 */

console.log("\nPhase 01 — Shell Contracts Verifier");
console.log("====================================");

const DOMAINS = [
  "shell",
  "hue",
  "device",
  "roomMap",
  "commands",
  "preview",
  "lighting",
  "telemetry",
  "statusCodes",
  "contractModules",
  "nullability",
];
for (const domain of DOMAINS) {
  await import(`./contracts/${domain}.mjs`);
}

const { totals } = await import("./contracts/lib.mjs");
const { errors, checks } = totals();
console.log(`\n====================================`);
if (errors === 0) {
  console.log(`✔  All ${checks} checks passed — shell contracts verified.\n`);
  process.exit(0);
} else {
  console.error(
    `✘  ${errors} of ${checks} checks FAILED — shell contracts incomplete.\n`
  );
  process.exit(1);
}
