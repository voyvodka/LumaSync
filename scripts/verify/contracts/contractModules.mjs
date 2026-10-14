import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT, VERIFY_DIR, fail, note, check, readOrEmpty, walkSourceFiles, stripComments } from "./lib.mjs";
import { contractModuleFiles, runtimeSourceFiles } from "./sources.mjs";

// Everything above proves a string is DECLARED. These three prove the
// declaration has a path to the running app — the telemetry fork had neither.

console.log("\n[ Contract files — runtime import reachability ]");
for (const file of contractModuleFiles) {
  const name = file.split("/").pop();
  const importers = runtimeSourceFiles.filter((f) =>
    readFileSync(f, "utf-8").includes(`shared/contracts/${name.replace(/\.ts$/, "")}"`)
  );
  check(
    importers.length > 0,
    `${name} imported by ${importers.length} runtime file(s)`,
    `ORPHAN CONTRACT "${name}" — no non-test file outside contracts/ imports it. `
      + `Every check against it is validating a file the app never loads.`
  );
}

// A feature may wrap a contract, never fork it: telemetry's private copy drifted
// two fields and the verifier kept passing against the shared file nobody read.
console.log("\n[ Feature-local contract modules — no standalone forks ]");
const featureContractModules = walkSourceFiles(resolve(ROOT, "src/features"), /^contracts\.ts$/);
for (const file of featureContractModules) {
  const rel = file.slice(file.indexOf("src/features/"));
  check(
    readFileSync(file, "utf-8").includes("@/shared/contracts/"),
    `${rel} derives from @/shared/contracts/`,
    `STANDALONE FORK "${rel}" — declares contract shapes without importing or `
      + `re-exporting @/shared/contracts/. Wrap the shared contract, do not copy it.`
  );
}

console.log("\n[ Contract value exports — runtime consumers (ratcheted) ]");
const DEAD_EXPORT_BASELINE_FILE = resolve(VERIFY_DIR, "contract-dead-export-baseline.txt");
const deadExportBaseline = new Set(
  readOrEmpty(DEAD_EXPORT_BASELINE_FILE, "dead export baseline")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
);

// Dynamic i18n heads are read from i18n-keys.mjs so there is one source of
// truth: `hue:runtime.codes.${code}` means those codes ARE consumed.
const i18nVerifierSource = readOrEmpty(
  resolve(VERIFY_DIR, "i18n-keys.mjs"),
  "i18n verifier"
);
const dynamicPrefixBlock = i18nVerifierSource.match(
  /const KNOWN_DYNAMIC_PREFIXES = \[([\s\S]*?)\]/
);
const dynamicPrefixes = dynamicPrefixBlock
  ? [...dynamicPrefixBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
check(
  dynamicPrefixes.length > 0,
  `read ${dynamicPrefixes.length} dynamic i18n prefixes from i18n-keys.mjs`,
  "EXTRACTION FAILED: could not read KNOWN_DYNAMIC_PREFIXES — every const whose "
    + "values are looked up dynamically would be misreported as dead"
);

function flattenCatalogue(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenCatalogue(value, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

const dynamicLeafNames = new Set();
try {
  const { I18N_NAMESPACES } = await import(
    pathToFileURL(resolve(ROOT, "src/features/i18n/namespaces.ts")).href
  );
  for (const ns of I18N_NAMESPACES) {
    const mod = await import(
      pathToFileURL(resolve(ROOT, "src/locales/en", `${ns}.ts`)).href
    );
    for (const key of flattenCatalogue(mod.default)) {
      const lastDot = key.lastIndexOf(".");
      if (lastDot < 0) continue;
      if (dynamicPrefixes.includes(`${ns}:${key.slice(0, lastDot)}`)) {
        dynamicLeafNames.add(key.slice(lastDot + 1));
      }
    }
  }
} catch (err) {
  fail(`EXTRACTION FAILED: cannot load the i18n catalogue (${err.message})`);
}

// Comment-stripped for the same reason the harvest is: deviceConnectionApi.ts
// names SerialHealthReport only in a JSDoc, which rescued the whole health-code
// family through a chain that no executing line supports.
const runtimeText = runtimeSourceFiles
  .filter((f) => !f.includes("__tests__"))
  .map((f) => stripComments(readFileSync(f, "utf-8")))
  .join("\n");

// Reachability must be transitive, not direct: NOTIFICATION_RESULT_CODES is read
// by nothing, yet deleting it breaks NotificationResult, which platformApi uses.
const declarationBodies = new Map();
for (const file of contractModuleFiles) {
  const source = readFileSync(file, "utf-8");
  const starts = [
    ...source.matchAll(/^(?:export )?(?:declare )?(?:const|function|type|interface|enum|class) ([A-Za-z_$][\w$]*)/gm),
  ];
  starts.forEach((decl, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    // Comments stripped: a JSDoc listing every code in the union would otherwise
    // mark the whole family reachable from prose alone.
    declarationBodies.set(decl[1], stripComments(source.slice(decl.index, end)));
  });
}
const reachable = new Set(
  [...declarationBodies.keys()].filter((symbol) =>
    new RegExp(`\\b${symbol}\\b`).test(runtimeText)
  )
);
for (let changed = true; changed; ) {
  changed = false;
  for (const symbol of [...reachable]) {
    const body = declarationBodies.get(symbol);
    if (!body) continue;
    for (const candidate of declarationBodies.keys()) {
      if (reachable.has(candidate)) continue;
      if (new RegExp(`\\b${candidate}\\b`).test(body)) {
        reachable.add(candidate);
        changed = true;
      }
    }
  }
}

let deadExports = 0;
for (const file of contractModuleFiles) {
  const name = file.split("/").pop();
  const source = readFileSync(file, "utf-8");
  for (const decl of source.matchAll(/^export (const|function) ([A-Za-z_$][\w$]*)/gm)) {
    const [, kind, symbol] = decl;
    if (reachable.has(symbol)) continue;
    if (kind === "const") {
      const block = source.slice(decl.index).match(/^export const [\s\S]*?\n\} as const;/);
      const values = block ? [...block[0].matchAll(/"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]) : [];
      if (values.some((value) => dynamicLeafNames.has(value))) continue;
    }
    const entry = `${name} ${symbol}`;
    if (deadExportBaseline.has(entry)) {
      note(`KNOWN GAP: ${entry} has no runtime consumer (baselined)`);
      deadExports++;
    } else {
      fail(
        `UNCONSUMED EXPORT ${entry} — nothing outside contracts/ reaches it, directly `
          + `or through another contract symbol, and no dynamic locale key covers it. `
          + `Wire it up, delete it, or baseline it with the reason.`
      );
    }
  }
}
for (const entry of deadExportBaseline) {
  const [fileName, symbol] = entry.split(" ");
  const stillDead = !reachable.has(symbol);
  check(
    stillDead,
    `baseline entry "${entry}" still has no runtime consumer`,
    `BASELINE STALE: "${entry}" now has a runtime consumer — delete its line from `
      + `contract-dead-export-baseline.txt (the file may only shrink)`
  );
  if (!contractModuleFiles.some((f) => f.endsWith(`/${fileName}`))) {
    fail(`BASELINE STALE: "${entry}" names ${fileName}, which is not a contract file`);
  }
}
check(
  deadExports === deadExportBaseline.size,
  `all ${deadExportBaseline.size} baselined dead exports accounted for`,
  `BASELINE DRIFT: ${deadExports} baselined entries matched but the file lists `
    + `${deadExportBaseline.size} — a stale line is hiding a real gap`
);
