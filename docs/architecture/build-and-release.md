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

## Gotchas

- **`cargo build` and `pnpm tauri build --debug` write the same path and produce different binaries.** Both land on `src-tauri/target/debug/lumasync`. The cargo one loads the frontend from the Vite dev server, so launching it without `pnpm dev` running gives a blank window and `Could not connect to localhost:1420` in the Web Inspector — an intact app with no content, indistinguishable from a broken one. Nothing about the path reveals which is there. Use `pnpm tauri dev`, or rebuild with `--debug --no-bundle` to embed the frontend. `scripts/verify/launch-smoke.mjs` asserts the frontend is embedded and fails immediately rather than waiting out its timeout.
- **`build.rs` embeds `windows-app-manifest.xml` into every linked target**, not just the bin. Test binaries reach comctl32 v6 through tauri's tray/menu stack, and Windows refuses to load them without the manifest (`STATUS_ENTRYPOINT_NOT_FOUND`).
- **CI passes `--test-threads=1` to `cargo test`, and it is not required.** The worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD` mutex shared by both test modules, so the suite passes at default parallelism. The flag predates that guard. Reproduce CI exactly only when chasing a CI-only failure.
- **A green CI run proves the debug binary starts, not the download.** `scripts/verify/launch-smoke.mjs` launches the debug binary on macOS and Linux; `release.yml` launches the mounted `.dmg` and the AppImage before the draft is published. Nothing launches the `.msi`.
- **`launch-smoke.mjs --log-file` deletes the file before launching.** Necessary, since a stale log would match the startup marker without the app ever starting — but it is a data-loss footgun outside CI, and macOS's case-insensitive filesystem makes `lumasync.log` and `LumaSync.log` the same file. `pnpm verify:launch-smoke` passes no `--log-file`, so the default path is safe.
- **No duplicate `## [X.Y.Z]` headings in `CHANGELOG.md`.** `release.yml` extracts notes with `awk` and stops at the first match.

## Accepted risks

- **Windows launch is unverified.** On a CI runner the app starts, Rust `setup()` completes with the tray built, WebView2 runs, the webview reports the bundle loaded — and then no frontend IPC ever completes and the app data directory is never created. Six causes were ruled out with evidence, including lost stdout (the PE subsystem is console, not GUI) and a failing `setup()`. Whether it reproduces on real Windows hardware is unknown. The smoke test is gated off Windows in both workflows rather than weakened into a green build, with the gap stated in each file. Tracked in [#181](https://github.com/voyvodka/LumaSync/issues/181).
- **The `.deb` is not launched in CI.** The release Ubuntu job has every webkit/gtk dev package installed, so installing it there resolves trivially and proves nothing about declared runtime dependencies on a clean machine. Testing it honestly needs a clean container.

## Resolved

- **v1.5.2 shipped a macOS build that could not launch** ([#115](https://github.com/voyvodka/LumaSync/issues/115)). Linking with a deployment target below 12.0 made dyld abort at launch on users' machines. An app that cannot start cannot run its own updater, so the fault was unrecoverable by the mechanism that exists to recover from faults, and affected users had to reinstall by hand. The deployment-target pin, `scripts/verify/macos-swift-runtime.sh`, and the entire launch smoke test all exist because of this one incident.
