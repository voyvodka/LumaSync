#!/usr/bin/env node
// Verifies every artefact an updater feed points at against the minisign public
// key the app ships with, before `release.yml` undrafts the release. The app
// performs the same check at install time, so a feed that fails here is a
// release no installed copy could ever accept. Why this is a Node script rather
// than the minisign CLI is in docs/architecture/build-and-release.md.
//
//   node scripts/verify/updater-signatures.mjs --feed latest.json \
//     --repo owner/name [--expect-version 1.2.3] [--config src-tauri/tauri.conf.json]
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** Minisign keys and signatures are text files; Tauri base64-encodes the whole file. */
function minisignLines(b64, what) {
  const lines = Buffer.from(b64, "base64").toString("utf8").split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:")) {
    throw new Error(`${what} is not a minisign file`);
  }
  return lines;
}

/** `Ed` + 8-byte key id + 32-byte Ed25519 key. */
function parsePublicKey(b64) {
  const raw = Buffer.from(minisignLines(b64, "public key")[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("public key is not a minisign Ed25519 key");
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
    format: "jwk",
  });
  return { keyId: raw.subarray(2, 10), key };
}

/** `Ed` (legacy, signs the file) or `ED` (signs its BLAKE2b-512), key id, 64-byte
 *  signature; then a trusted comment and a global signature over sig ‖ comment. */
function parseSignature(b64) {
  const lines = minisignLines(b64, "signature");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  const prefix = "trusted comment: ";
  if (raw.length !== 74 || !trusted.startsWith(prefix)) {
    throw new Error("signature is malformed");
  }
  const algorithm = raw.subarray(0, 2).toString();
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`unknown signature algorithm ${JSON.stringify(algorithm)}`);
  }
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice(prefix.length),
    globalSignature: Buffer.from(lines[3] ?? "", "base64"),
  };
}

function verifyMinisign(publicKeyB64, signatureB64, data) {
  const pub = parsePublicKey(publicKeyB64);
  const sig = parseSignature(signatureB64);
  if (!sig.keyId.equals(pub.keyId)) {
    return `signed by key ${sig.keyId.toString("hex")}, expected ${pub.keyId.toString("hex")}`;
  }
  const message = sig.algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, pub.key, sig.signature)) {
    return "signature does not match the file";
  }
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, global, pub.key, sig.globalSignature)) {
    return "trusted comment signature does not match";
  }
  return null;
}

/** The feed must point into this repository's releases and nowhere else. Draft
 *  assets are not publicly downloadable, so both forms go through `gh`. */
function download(url, repo) {
  const apiPrefix = `https://api.github.com/repos/${repo}/releases/assets/`;
  if (url.startsWith(apiPrefix) && /^\d+$/.test(url.slice(apiPrefix.length))) {
    return execFileSync(
      "gh",
      ["api", "-H", "Accept: application/octet-stream", url.slice("https://api.github.com/".length)],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
  }
  const webPrefix = `https://github.com/${repo}/releases/download/`;
  if (url.startsWith(webPrefix)) {
    const [tag, ...rest] = url.slice(webPrefix.length).split("/");
    const name = decodeURIComponent(rest.join("/"));
    return execFileSync(
      "gh",
      ["release", "download", decodeURIComponent(tag), "--repo", repo, "--pattern", name, "--output", "-"],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
  }
  throw new Error(`points outside ${repo}'s releases: ${url}`);
}

function main() {
  const feedPath = arg("feed");
  const repo = arg("repo", process.env.GITHUB_REPOSITORY);
  const configPath = arg("config", join(repoRoot, "src-tauri", "tauri.conf.json"));
  const expectVersion = arg("expect-version");
  if (!feedPath || !repo) fail("usage: --feed <latest.json> --repo <owner/name>");

  const pubkey = JSON.parse(readFileSync(configPath, "utf8"))?.plugins?.updater?.pubkey;
  if (!pubkey) fail(`no plugins.updater.pubkey in ${configPath}`);

  const feed = JSON.parse(readFileSync(feedPath, "utf8"));
  if (expectVersion && feed.version !== expectVersion) {
    fail(`feed says version ${feed.version}, expected ${expectVersion}`);
  }
  const platforms = Object.entries(feed.platforms ?? {});
  if (platforms.length === 0) fail("feed lists no platforms");

  // Several platform keys share one artefact (darwin-* is one universal
  // bundle); fetch each URL once, but check every entry's own signature.
  const cache = new Map();
  let failures = 0;
  for (const [platform, entry] of platforms) {
    let problem;
    try {
      if (!entry?.url || !entry?.signature) throw new Error("missing url or signature");
      if (!cache.has(entry.url)) cache.set(entry.url, download(entry.url, repo));
      problem = verifyMinisign(pubkey, entry.signature, cache.get(entry.url));
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      failures += 1;
      console.error(`::error::${platform}: ${problem}`);
    } else {
      console.log(`ok  ${platform}  (${cache.get(entry.url).length} bytes)`);
    }
  }
  if (failures > 0) fail(`${failures} of ${platforms.length} feed entries failed signature verification`);
  console.log(`All ${platforms.length} feed entries verify against the shipped updater key.`);
}

main();
