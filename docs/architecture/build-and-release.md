# Building, testing, and releasing

The traps here cost the most time per incident, and one of them shipped a broken release.

## Decisions

**`MACOSX_DEPLOYMENT_TARGET` is pinned to 12.3** at workflow level in both CI and release.
Lowering it reintroduces the v1.5.2 launch crash — see *Resolved* below.

**Releases are patch bumps.** For the foreseeable future, whatever the change contains. Do not
classify the bump from the diff. A genuinely breaking change still ships under a patch number, so
it has to be called out in the release notes in as many words.

**Three version locations move in lockstep:** `src-tauri/Cargo.toml`, `package.json`,
`SECURITY.md`. Then `cargo check` to refresh `Cargo.lock`. `tauri.conf.json` has no version field
— it inherits from `Cargo.toml`.

**Publication is two-stage.** The build matrix uploads into a *draft* (`releaseDraft: true`) so the
updater feed never sees a platform-incomplete `latest.json`; a `publish` job then asserts all four
platform keys before undrafting. A `-` in the tag marks it prerelease.

**Updates ship through GitHub Releases with minisign verification.** The updater checks on startup
and surfaces `UpdateModal.tsx`. Artefacts must include a `latest.json` endpoint.

**Tests live in a `__tests__/` subfolder beside the code under test** (`foo.ts` →
`__tests__/foo.test.ts`), never co-located. Mock the Tauri boundary for deterministic frontend
tests. Only add or adjust tests for changed behaviour.

**Work lands on `main` through pull requests.** Branch protection requires four checks:
`Build and Check (ubuntu-24.04)`, `Build and Check (macos-latest)`,
`Build and Check (windows-latest)`, `Analyze (javascript-typescript)`. Renaming a workflow job
renames its status context, and a required context that no job produces blocks every PR until an
admin overrides it.

**The beta update channel is fed from an anchor release, because GitHub has no "latest prerelease"
URL.** The stable endpoint in `tauri.conf.json` resolves through
`/releases/latest/download/latest.json`, and `/releases/latest` returns the newest release that is
neither a draft nor a prerelease — so a prerelease's `latest.json` is unreachable at any stable
address. The `publish` job therefore copies it onto a fixed release tagged `beta-channel` as
`latest-beta.json`. Three properties make that safe, and each is load-bearing:

- **The anchor is itself marked prerelease.** That is the only thing keeping it out of
  `/releases/latest`; a normal release there would hijack the stable feed for every install.
- **Stable tags refresh it too.** Beta is a *superset* of stable, not a fork of it. Without this a
  tester sitting on `1.5.5-rc.2` would never be offered `1.5.6`.
- **The refresh runs after the four-platform assertion and before the undraft.** A failure leaves
  the release a draft and the job re-runnable; a published release with a stale beta feed is worse
  than one that has not published yet.

The `beta-channel` tag does not match `release.yml`'s `v*.*.*` trigger, so creating it cannot
recurse into another release run.

**A prerelease tag publishes its core version's changelog section.** `v1.5.4-rc.1` looks for
`## [1.5.4-rc.1]` first and falls back to `## [1.5.4]`, because an rc *is* the candidate for that
release and giving every rc its own heading is bookkeeping with no reader. Falling back to
`## [Unreleased]` was rejected: it would ship notes for work that is not in the build. Both empty
means the job fails — there is no placeholder.

**A prerelease carries its suffix in the tree version, and MSI needs a pinned version because of it.**
`tauri-action` reads the version from `Cargo.toml`/`package.json`, not from the tag — so a tree
reading plain `1.5.5` produces artefacts named `LumaSync_1.5.5_*` and a feed saying `1.5.5` even when
the tag is `v1.5.5-rc.1`. The updater decides with `release.version > current_version`, so that build
can never be upgraded to `rc.2` or to stable `1.5.5`: both comparisons are `1.5.5 > 1.5.5`. The three
version locations therefore carry `1.5.5-rc.1` in full.

The MSI bundler refuses that: *"optional pre-release identifier in app version must be numeric-only
and cannot be greater than 65535 for msi target"*. `bundle.windows.wix.version` is pinned to the core
`X.Y.Z` instead of being derived, which makes it a **fourth** version location — and the tag gate
checks it, because a stale pin is a Windows upgrade that silently never triggers.

**Windows cannot upgrade between builds that share an `X.Y.Z`, and no version scheme fixes it.**
Microsoft is explicit: *"Windows Installer uses only the first three fields of the product version.
If you include a fourth field in your product version, the installer ignores the fourth field"*, and
*"at least one of the three fields of ProductVersion must change for an upgrade"*. So `1.5.5-rc.1`,
`1.5.5-rc.2` and `1.5.5` all present as `1.5.5` to Windows Installer, and the updater's
`msiexec /i` does not perform an upgrade between them. Using a numeric suffix (`1.5.5-1` →
`1.5.5.1`) changes nothing, because that lands in the ignored fourth field. **Windows testers must
reinstall each release candidate by hand.** The real fix is to make NSIS the Windows updater target —
it overwrites rather than consulting a product version — which is a separate change.

## Gotchas

- **`cargo build` and `pnpm tauri build --debug` write the same path and produce different binaries.** Both land on `src-tauri/target/debug/lumasync`. The cargo one loads the frontend from the Vite dev server, so launching it without `pnpm dev` running gives a blank window and `Could not connect to localhost:1420` in the Web Inspector — an intact app with no content, indistinguishable from a broken one. Nothing about the path reveals which is there. Use `pnpm tauri dev`, or rebuild with `--debug --no-bundle` to embed the frontend. `scripts/verify/launch-smoke.mjs` asserts the frontend is embedded and fails immediately rather than waiting out its timeout.
- **`build.rs` embeds `windows-app-manifest.xml` into every linked target**, not just the bin. Test binaries reach comctl32 v6 through tauri's tray/menu stack, and Windows refuses to load them without the manifest (`STATUS_ENTRYPOINT_NOT_FOUND`).
- **CI passes `--test-threads=1` to `cargo test`, and it is not required.** The worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD` mutex shared by both test modules, so the suite passes at default parallelism. The flag predates that guard. Reproduce CI exactly only when chasing a CI-only failure.
- **A green CI run proves the debug binary starts, not the download.** `scripts/verify/launch-smoke.mjs` launches the debug binary on macOS and Linux; `release.yml` launches the mounted `.dmg` and the AppImage before the draft is published. Nothing launches the `.msi`.
- **`launch-smoke.mjs --log-file` deletes the file before launching.** Necessary, since a stale log would match the startup marker without the app ever starting — but it is a data-loss footgun outside CI, and macOS's case-insensitive filesystem makes `lumasync.log` and `LumaSync.log` the same file. `pnpm verify:launch-smoke` passes no `--log-file`, so the default path is safe.
- **No duplicate `## [X.Y.Z]` headings in `CHANGELOG.md`.** `release.yml` extracts notes with `awk` and stops at the first match.

## Accepted risks

- **Windows has no launch coverage, and the reason is not the runner.** The hang was reproduced on bare-metal Windows 11 with a real GPU, so the original "CI-runner artefact" framing was wrong. The axis is **debug profile vs release profile**: the shipped v1.5.4 MSI runs and `tauri dev` works, while `--debug --no-bundle` hangs everywhere — the main document never loads, DevTools reports `chrome-error://chromewebdata/`. A second defect was confirmed alongside it: the console→log bridge is dead on Windows, which means `launch-smoke.mjs` **cannot pass there regardless of app health**, since its pass criterion is a frontend `console.info` arriving through that bridge. Covering Windows needs the bridge fixed or a marker that does not route through the log plugin. The smoke test stays gated off Windows in both workflows rather than weakened into a green build, with the gap stated in each file. Tracked in [#181](https://github.com/voyvodka/LumaSync/issues/181); the instrumentation half landed in #198.
- **The `.deb` is not launched in CI.** The release Ubuntu job has every webkit/gtk dev package installed, so installing it there resolves trivially and proves nothing about declared runtime dependencies on a clean machine. Testing it honestly needs a clean container.

## Resolved

- **v1.5.2 shipped a macOS build that could not launch** ([#115](https://github.com/voyvodka/LumaSync/issues/115)). Linking with a deployment target below 12.0 made dyld abort at launch on users' machines. An app that cannot start cannot run its own updater, so the fault was unrecoverable by the mechanism that exists to recover from faults, and affected users had to reinstall by hand. The deployment-target pin, `scripts/verify/macos-swift-runtime.sh`, and the entire launch smoke test all exist because of this one incident.
