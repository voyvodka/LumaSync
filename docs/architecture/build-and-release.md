# Building, testing, and releasing

The traps here cost the most time per incident, and one of them shipped a broken release.

## Decisions

**`MACOSX_DEPLOYMENT_TARGET` is pinned to 12.3, in three places on purpose**: workflow-level `env`
in `ci.yml` and `release.yml`, `force = true` in `src-tauri/.cargo/config.toml`, and
`bundle.macOS.minimumSystemVersion`. `tauri build` exports the minimum system version (10.13 when
unset) as a real env var, and a non-forced Cargo `[env]` entry loses to any pre-set value — each
layer covers a build path another misses. Lowering it reintroduces the v1.5.2 launch crash — see
*Resolved* below. The macOS jobs also select the newest installed Xcode: `screencapturekit` pulls
`apple-metal`, whose Swift bridge needs the macOS 26 SDK at compile time; its `#available` guard
keeps the binary runnable on 12.3. (The step names still say "screencapturekit 8"; the lockfile is
on 10.x.)

**The Rust toolchain is pinned to an exact version** in `rust-toolchain.toml`, not `stable`. A new
stable release brings new clippy lints, and CI runs clippy at deny level, so a floating channel turns
an unrelated PR red on the day a release ships. Both workflows still run
`dtolnay/rust-toolchain` (pinned to a commit of its `stable` branch) for its environment defaults and
then `rustup toolchain install`, which reads the file — the pinned toolchain has to exist before `release.yml` adds the macOS targets
to it. Bump the pin deliberately, in a PR that also fixes whatever the new clippy finds.

**The release profile is thin LTO, one codegen unit, stripped — and `panic = "unwind"` on purpose.**
A panicking worker or command must unwind: its thread dies alone, the locks it held poison and are
recovered (`unwrap_or_else(|e| e.into_inner())` in several status reads), and a panic inside a
`spawn_blocking` body comes back as a coded error. `abort` would turn each of those into the whole
app vanishing from the tray. `panic_log.rs` routes every panic — thread, location, message — into
the log file, chained to the default hook; a released Windows GUI process has no stderr, so a panic
there used to leave no trace at all.

**`Info.plist` carries the macOS usage strings**, merged into the bundle by
`bundle.macOS.infoPlist`: screen recording, and `NSLocalNetworkUsageDescription`, without which
macOS 15 shows the local-network prompt (Hue bridge discovery and streaming, WLED) with no
explanation. mDNS here is raw multicast sockets rather than `NSNetService`, so no `NSBonjourServices`
list is involved.

**Releases are patch bumps.** For the foreseeable future, whatever the change contains. Do not
classify the bump from the diff. A genuinely breaking change still ships under a patch number, so
it has to be called out in the release notes in as many words.

**Four version locations move in lockstep:** `src-tauri/Cargo.toml`, `package.json`,
`SECURITY.md`, and `bundle.windows.wix.version` in `tauri.conf.json`. Then `cargo check` to refresh
`Cargo.lock`. The first three carry the full version including any prerelease suffix; the wix one
carries the bare `X.Y.Z` (why is under the prerelease entry below). The app version
itself is inherited from `Cargo.toml` — `tauri.conf.json` has no top-level version field.

**Publication is two-stage.** The build matrix uploads into a *draft* (`releaseDraft: true`) so the
updater feed never sees a platform-incomplete `latest.json` — anything under `/releases/latest/` is
live the instant it is published, and each matrix job used to upload into a published release, so
the first to finish exposed a one-OS feed. `publish` then asserts all four platform keys, checks the
signatures, refreshes the beta feed, and only then undrafts. Any failure leaves a draft, and a
re-run is safe: `tauri-action` gets-or-creates the release by tag and replaces same-named assets. A
`-` in the tag marks it prerelease. A complete release carries a universal `.dmg` and
`.app.tar.gz`, an `.msi` and NSIS `-setup.exe`, an `.AppImage`, `.deb` and `.rpm`, a `.sig` beside
every updater artefact (the `.dmg` has none; it is not an update payload), and `latest.json`.

**Only the updates are signed.** minisign signs the updater artefacts; the builds themselves are
ad-hoc code-signed on macOS (no Developer ID, not notarized) and unsigned on Windows, where
SmartScreen shows an unknown publisher. Never describe a release as notarized or
Authenticode-signed. What ad-hoc signing costs users is under *Keychain prompts in dev*.

**GitHub Releases is the only distribution channel**, because that is where the updater feed
lives. Package-manager channels are blocked on prerequisites rather than effort: Homebrew disables
casks that fail Gatekeeper, which an ad-hoc-signed build does, and a Flatpak needs
Wayland capture (a Wayland user would get none today) plus `--device=all` for serial. Container and
headless packaging are not built at all — LumaSync is a tray app, not a daemon.

**Every updater artefact is signature-checked before the release is undrafted.** After the
four-platform assertion, `publish` runs `scripts/verify/updater-signatures.mjs`: it downloads each
file `latest.json` names from the draft and verifies the entry's minisign signature against
`plugins.updater.pubkey` in the tagged `tauri.conf.json` — the check every installed copy runs
before applying an update. A signing secret rotated in CI but not in the tree (or the reverse), or a
feed that pairs a signature with the wrong file, fails here instead of on users' machines. It also
refuses a URL outside this repository's releases and a feed whose `version` is not the tag's.
It is a small Node script rather than the `minisign` CLI because the runner carries no minisign and
Node's `crypto` already has Ed25519 and BLAKE2b-512, so nothing is installed at publish time; and
because it could be proven against the real `v1.5.5-rc.6` feed (13 entries, six artefacts) plus a
swapped signature, an edited trusted comment, a foreign key and an outside URL, each of which it
refused.

**The Linux release is built on `ubuntu-22.04`, the oldest runner, and that is the glibc floor.** A
binary takes its glibc symbol versions from the build host, so the `ubuntu-24.04` build (glibc 2.39)
could not load on Ubuntu 22.04 or Debian 12. Building on 22.04 puts the floor at glibc 2.35, which
the README states. Only `release.yml` moved: `ci.yml`'s matrix entries are required status
contexts, and its 24.04 build is still what the launch smoke and the Secret Service bench run on.
When GitHub retires the 22.04 image the floor rises with whatever replaces it — say so in the
release notes that ship it.

**Every action is pinned to a full commit SHA, with the release it came from as a comment.** A tag
can be moved to new code by whoever controls the action's repository; a SHA cannot. Dependabot's
`github-actions` ecosystem reads the `# vX.Y.Z` comment and bumps both together.
`dtolnay/rust-toolchain` publishes no releases, so it is pinned to a commit of its `stable` branch
and has to be bumped by hand. Every `actions/checkout` sets `persist-credentials: false`: no job
pushes (releases go through `gh` and the REST API), so leaving the token in the checkout's config
only exposes it to every later step.

**The supply-chain gates, and which job owns each.**

- **`cargo audit`** (in `ci.yml` and `release.yml`) owns Rust advisories, and
  `src-tauri/.cargo/audit.toml` ignores nothing. An ignore added there carries its justification
  in that file, is re-checked every release, and goes the moment the parent bumps. The allowed
  *warnings* it prints — unmaintained `unic-*` via `urlpattern`, `proc-macro-error`, unsound `glib`
  0.18 — arrive through Tauri's own tree, mostly its Linux GTK3 stack. They are not actionable
  here and are not to be pinned around.
- **`dependency-review`** gates each PR's *changed* dependencies: it fails on a high-severity
  advisory, and its licence allow-list is the union of `deny.toml`'s and the npm scan's, so it
  refuses nothing the full-tree scan accepts. Copyleft (GPL, LGPL, AGPL, EUPL, SSPL) is refused by
  absence. A dependency whose licence string GitHub cannot map fails with its name in the log — add
  its purl to `allow-dependencies-licenses` with a reason rather than widening the list.
- **`license-scan`** is the full-tree backstop, weekly and on any PR touching either lockfile or
  `deny.toml`, because `dependency-review` sees only what changed and once passed a crate whose
  licence it could not parse. `cargo deny check licenses sources bans`: crates.io is the only
  allowed source, a git dependency has to be listed in `deny.toml` with a reason, wildcard version
  requirements are denied, and duplicate versions only warn — the ~60 there today are almost all
  the `windows-sys` family pulled at different majors by tauri, tao, wry and the capture crates.
- **CodeQL** analyses `javascript-typescript`, `rust` and `actions`, all with `build-mode: none`;
  only `Analyze (javascript-typescript)` is a required context, so the matrix entry keeps that
  exact name.
- **Dependabot** runs weekly for cargo, npm (it reads `bun.lock`) and Actions, minor and patch
  grouped per ecosystem, majors alone for individual review. It offers no prerelease unless a
  package is already on a prerelease track, which is what keeps the tree on latest stable without
  an ignore rule.

**Updates ship through GitHub Releases with minisign verification.** The updater checks on startup
and then daily while the app runs, retrying a failed check after 1, 5 and 15 minutes, and surfaces
`UpdateModal.tsx` when a version is available. A failed automatic check is only logged and raised as
a low-priority shell notice with "Try again"; the modal reports a failure only for a check the user
started (see `ui-and-shell.md`). The e2e build skips automatic checks. Artefacts must include a
`latest.json` endpoint.

**The update channel defaults to the running build.** An install that never chose a channel checks
beta while it runs a prerelease (a version with a `-` suffix) and stable otherwise;
`resolve_update_channel` in `commands/updater.rs` and `defaultUpdateChannel` in
`contracts/shell.ts` must agree. An explicit choice always wins, and any stored value but an exact
`"beta"` stays stable, so a corrupt store still never moves anyone onto prereleases. The prerelease
default is the one sanctioned exception, for someone already running one: on stable they would
never be offered the next.

**Tests live in a `__tests__/` subfolder beside the code under test** (`foo.ts` →
`__tests__/foo.test.ts`), never co-located. Mock the Tauri boundary for deterministic frontend
tests. Only add or adjust tests for changed behaviour.

**Work lands on `main` through pull requests.** Branch protection requires four checks:
`Build and Check (ubuntu-24.04)`, `Build and Check (macos-latest)`,
`Build and Check (windows-latest)`, `Analyze (javascript-typescript)`. Renaming a workflow job
renames its status context, and a required context that no job produces blocks every PR until an
admin overrides it — which happened once, with a stale `typecheck` context. `E2E (macos-latest)` is
deliberately not required (see [`testing-and-verification.md`](testing-and-verification.md)) and
must never take one of those four names.

**CI splits by what actually varies per platform.** `check:all`, `bun run test` and `cargo audit`
run on Linux only; three OSes would add minutes and no signal. `cargo fmt`, `clippy -D warnings`
and `cargo test` run on all three and are *not* part of `check:all`, so a green `check:all` on a
Rust branch can still fail CI on formatting. CI cancels superseded runs; `release.yml` never does,
because a half-published release is worse than a wasted run.

There is no docs-only path filter, on purpose. A job-level `if:` on the matrix job skips it, and a
skipped matrix never produces the required `Build and Check (*)` contexts, so every docs PR would
wait on checks that never arrive. Only per-step conditions would be safe, and the minutes saved did
not justify them.

**A change that needs real hardware may merge before its device check, but never ship before it.**
When a Hue bridge or a strip is not at hand, a PR that is green locally and in CI merges so the work
built on it is not blocked; its device checklist goes on the pre-release list, and the release waits
for it. CI and fakes prove the code does what its tests say, not what a bridge or a controller does.

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

**A tag push is not gated by branch protection, so `release.yml` gates it itself.** Protection rules
apply to pull requests into `main`; nothing stops a tag on any commit, including one that never saw
review. The release job therefore asserts the tagged commit is contained in `main` and was
introduced by a *merged* pull request. Provenance is checked rather than re-running the required
contexts against the merge commit: `ci.yml` sets `cancel-in-progress`, so a superseded commit's run
shows `cancelled` even when its PR was fully green — requiring `success` there would block
legitimate releases. A merged PR cannot exist without the four required checks having passed, which
is the same guarantee arrived at from the other side. So the tag goes on the squash-merge commit on
`main`, never on a branch commit. A third gate refuses a tag that sorts below an existing one under
semver (`v1.5.4-rc.1` after `v1.5.4`): the version gate compares core versions only and cannot see
a backwards tag, which would ship a feed older than what users run.

**The version gate also runs on every PR, not only on a tag.** `scripts/verify/version-parity.mjs`
is in `check:all` and applies the same rules as the tag gate — plus two the workflow cannot check
from a tag alone: that `Cargo.lock`'s `lumasync` entry was refreshed by `cargo check`, and that
`CHANGELOG.md` has exactly one heading for the version. Its `sed`/`jq` equivalents are deliberately
copied rather than reimplemented; a check that reads the files differently can pass where the gate
fails, which is worse than no check. Learning at tag time that a version drifted is the most
expensive moment to learn it: the work is already merged.

`release.yml` re-runs only part of `check:all`: the Rust checks on all three platforms, and on Linux
`verify:shell-contracts`, `typecheck:e2e` and `check:i18n`. `check:i18n` is the
orphaned-translation-key ratchet, and a tag push runs no CI, so this is the only place it can catch
one before publication. Biome lint, `typecheck:mock`, `verify:event-names`,
`verify:mock-not-shipped`, `verify:design-tokens` and `verify:untyped-mocks` are not re-run at tag
time. **Nor, in practice, is `verify:window-grants`**: its release step is conditioned on
`ubuntu-24.04`, which left the release matrix when Linux moved to 22.04, so it is skipped on every
tag. It still gates every PR through `check:all`.

**`CHANGELOG.md` is a reader-facing release note, not an audit log** — the commit history is the
audit log. Keep a Changelog 1.1.0 headings, plus a house `### Internal` for changes only a
contributor would notice. Each bullet is written from the user's side and summarises a theme; one
that reads like a commit message belongs folded into its nearest theme. Dependency bumps get one
line per ecosystem (Rust, frontend, GitHub Actions), naming a package only for a major version or a
user-visible effect. Purely internal changes — a removed constant, a moved test — are left out. An
rc cut folds `[Unreleased]` into the core `## [X.Y.Z]` heading, undated; the stable release adds
`— YYYY-MM-DD`. Anything still under `[Unreleased]` at tag time is missing from that build's notes.

## The package manager and its dependency overrides

**Bun is the package manager, and `bunfig.toml` pins `linker = "isolated"`.** Bun defaults to the
hoisted linker for a single-package repo, which flattens every transitive dependency into the top
level of `node_modules`. That silently removes the phantom-dependency protection the previous pnpm
setup gave us: an import of a package we never declared would resolve at runtime and pass CI, then
break for anyone installing with a different resolver. Isolated keeps the symlinked layout, so only
the declared dependencies sit at the top level — `ls node_modules | wc -l` should report 17, not
several hundred. Do not drop the file to "simplify" the install.

**`bun test` is not `bun run test`.** The first is Bun's own runner, which ignores
`vitest.config.ts` and turns the suite into hundreds of failures that read like a regression.
`bunfig.toml`'s `[test] root` confines it to `scripts/bun-test-guard`, whose one failing test names
the right command. Node stays installed (22 in CI) — vitest, wdio, the Tauri CLI and every
`scripts/verify/*.mjs` run under it — but it is never the package manager.

**Three dependency overrides in `package.json` are security fixes, not preferences.** `package.json`
is strict JSON and cannot carry the reasoning inline, so it lives here — they were annotated in
`pnpm-workspace.yaml` before the move to Bun. Each one exists to clear a GitHub advisory that the
direct dependency tree cannot resolve on its own:

- **`undici` → `^7.29.0`.** Reached transitively through the WebdriverIO e2e stack (`webdriver`
  asks for `^6`, `cheerio` for `^7`), so dev-only. Clears the advisories against `undici` < 7.29.0 — SOCKS5 cross-origin routing and TLS
  certificate validation bypass among them.
- **`serialize-javascript` → `^7.1.0`.** mocha still pins `^6.0.2`, which both GHSA-5c6j-r48x-rmvq
  (RCE) and GHSA-qj8w-gfj5-8c6v cover. 7.0.5 was the first release clear of the pair.
- **`@puppeteer/browsers` → `^3.2.0`.** The 2.x line pulls `extract-zip` (GHSA-jmr9-qjv8-65gv),
  which is unmaintained and has no patched release. Bumping the parent is the only exit.

Drop one when its upstream ships a clean release, not before — `cargo audit`'s frontend counterpart
is the weekly `license-scan` and Dependabot, and neither will re-raise a silenced advisory.

**`trustedDependencies` is limited to `esbuild`.** Bun runs no install scripts unless the package is
listed. `edgedriver` and `geckodriver` both arrive with `@wdio/cli`, and the e2e suite uses the
embedded WebDriver provider, so their driver downloads are dead weight; leaving them unlisted skips
those downloads. `esbuild` genuinely needs its postinstall to fetch a platform binary.

## Gotchas

- **`cargo build` and `bun run tauri build --debug` write the same path and produce different binaries.** Both land on `src-tauri/target/debug/lumasync`. The cargo one loads the frontend from the Vite dev server, so launching it without `bun run dev` running gives a blank window and `Could not connect to localhost:1420` in the Web Inspector — an intact app with no content, indistinguishable from a broken one. Nothing about the path reveals which is there. Use `bun run tauri dev`, or rebuild with `--debug --no-bundle` to embed the frontend. `scripts/verify/launch-smoke.mjs` asserts the frontend is embedded and fails immediately rather than waiting out its timeout.
- **`build.rs` embeds `windows-app-manifest.xml` into every linked target**, not just the bin. Test binaries reach comctl32 v6 through tauri's tray/menu stack, and Windows refuses to load them without the manifest (`STATUS_ENTRYPOINT_NOT_FOUND`).
- **CI passes `--test-threads=1` to `cargo test`, and it is not required.** The worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD` mutex shared by all three test modules (`transition_tests`, `lighting_mode_tests`, `frame_pipeline_tests`), so the suite passes at default parallelism. The flag predates that guard. Reproduce CI exactly only when chasing a CI-only failure.
- **A green CI run proves the debug binary starts, not the installer.** `scripts/verify/launch-smoke.mjs` launches debug binaries on all three platforms; Windows uses `tauri.windows-smoke.conf.json` because WebView2 can lose the embedded top-level request when a debug webview starts hidden. `release.yml` launches the mounted `.dmg`, the AppImage, and the Windows release binary before the draft is published. The `.msi` and `.deb` installers themselves are not installed in CI.
- **Log lines twice: `tauri_plugin_log::Builder::new()` already carries `[Stdout, LogDir { file_name: None }]`, and `.target()` appends.** Two `.target()` calls therefore made four sinks: stdout twice (every line doubled in `bun run tauri dev` and in CI's captured stdout), our named file, and a second file named after the package — `LumaSync.log`. In release that second name and our `lumasync.log` are the same file on macOS and Windows, so the release log carried every line twice; in dev it left a stray `LumaSync.log` next to `lumasync-dev.log`, which is the file the smoke `--log-file` deletion below once destroyed. `.targets([...])` replaces the default set instead of adding to it. A line seen once on stdout and once in the file is the two sinks doing their job; the same line twice in one place is a regression of this.
- **`launch-smoke.mjs --log-file` scans the file from its size at launch and never deletes it.** A stale log would match the startup marker without the app ever starting, so only bytes appended after the script starts count; a file that is *shorter* than it was at launch was rotated or truncated and is read from the top. It used to delete the file instead, which on a developer machine is the live log — and on macOS's case-insensitive filesystem `lumasync.log` and `LumaSync.log` are the same file, so it once destroyed months of history. `overlay-smoke.mjs` follows the same rule.
- **No duplicate `## [X.Y.Z]` headings in `CHANGELOG.md`.** `release.yml` extracts notes with `awk` and stops at the first match. It also stops at a bare `---` line, so a horizontal rule inside a section silently truncates the published notes.
- **`CHANGELOG.md` merges with `merge=union`** (`.gitattributes`). Nearly every PR adds a line under `[Unreleased]`, so with several branches open each merge of `main` into the others used to stop on a conflict that was only two additions side by side. Union keeps both sides. It cannot tell an edit from an addition: two branches rewording the same line keep both versions, and two branches adding the same heading keep it twice — `[Unreleased]` routinely ends up with two `### Added` — so read the section after a merge and merge repeated subsections when folding it, and check the rule above before tagging. GitHub's own merge button ignores the attribute; it applies when `main` is merged into a branch locally.
- **`chunkSizeWarningLimit` is a ratchet rather than a mute.** Vite's 500 kB default measures download cost over a network; a Tauri bundle is read off local disk and never pays it — what matters here is parse time and memory per webview. Since the per-window split (`ui-and-shell.md`, "Per-window bundles") the largest chunk is the shared entry, React plus i18next at about 265 kB, and the limit sits just above it at 300 kB so real growth still trips it. A warning now most likely means something heavy was imported statically from `main.tsx`, which every window, including each twin overlay, would parse.
- **The test environment installs its own `localStorage`** in `src/test/setup.ts`. Node ≥ 24 defines an experimental `localStorage` global that reads back as `undefined` without `--localstorage-file`, and it shadows the one happy-dom provides. CI runs Node 22 and never saw it; on a newer local Node every `HsvColorPicker` recent-colors read and write threw into its own `catch`, so the feature was inert in tests and nothing failed. Anything reached through `window` deserves the same suspicion when local and CI Node versions differ.

- **Never share `CARGO_TARGET_DIR` across worktrees.** The `lumasync` package hashes collide across checkouts, so tauri-build's generated capability ACL from one branch ended up in another branch's binary, which then refused a command at runtime while its probe still passed. Every worktree builds in its own `src-tauri/target`.
- **A worktree without its own `node_modules` resolves an ancestor's.** Module resolution walks up the directory tree, so a worktree placed inside the checkout picks up the main copy; a stale one there once dropped the bundled fonts from a build. Run `bun install --frozen-lockfile` in every worktree before building.
- **sccache was measured and reverted.** A cold `cargo test --no-run` took 79 s without it and 131 s with a warm cache, and the incremental main crate is never cacheable, so it cost time rather than saving it.

## The Windows overlay probe

The `windows-latest` CI job is the only Windows desktop the calibration overlay
ever reaches, so it is the test bench for R29 (overlay opens blank / wedges the
app). One step runs after the Windows launch smoke and **gates the job**:
`scripts/verify/overlay-smoke.mjs --mode default --gate`, which fails unless the
overlay painted its edge band (≥ 1 % changed), stayed transparent (≤ 10 % of the
interior changed) and both hit-test points fell through it.

**What the first runs established (2026-08-18, PR #316).** With the sweep in its
default `transparent` mode the overlay drew its capsules over the desktop — edge band
5.1 % changed, interior 0.2 %, `WindowFromPoint` at the centre resolved to the main
window's webview underneath and at the top edge to the desktop's `SysListView32`.
With `--mode transparent+layered`, the ≤ 1.5.5 sweep, **the whole display went solid
black** — 69 % of the band and 33.5 % of the interior changed, `after.png` is black
edge to edge — while hit-testing still fell through. That is the R29 report
("nothing on screen, nothing to click"), reproduced and released by one flag. The
sweep also showed the WebView2 tree the overlay contains: `WRY_WEBVIEW` and
`Chrome_WidgetWin_0` in our process, `Chrome_WidgetWin_1` and
`Chrome_RenderWidgetHostHWND` in the browser process, `Intermediate D3D Window` in
the GPU process already carrying `WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP` of its
own; `SetWindowLongPtrW` landed cross-process on all of them. It also showed the
last-error slot reading 6 after a set that had landed on an in-process window, which
is why the sweep judges success by re-reading the style rather than by the return
value.

A run launches the same debug binary the launch smoke uses with
`LUMASYNC_SMOKE_OVERLAY_TRIGGER` pointing at a file. A debug-only watcher
(`src-tauri/src/smoke_overlay.rs`) polls for that file and, when it appears, opens
the calibration overlay on the primary display through the ordinary
`open_display_overlay` path, then logs `[smoke-overlay] opened … outer=x,y WxH` so
the rect is known from outside the process. `scripts/verify/win-overlay-probe.ps1`
then reads the result from the outside: every top-level window of the PID and every
descendant with class, owning PID and `GWL_EXSTYLE` in hex;
`WindowFromPoint` at the overlay centre and 3% inside the top edge; and a
pixel diff of the overlay rect against a baseline screenshot taken before the
overlay opened, split into an outer 8% band (where the LED capsules are drawn) and
the inner region.

Reading the `overlay-smoke-windows` artefact: `probe.json` carries the whole dump
plus a `verdict` block, `sweep-log.txt` holds every `[overlay-sweep]` and
`[smoke-overlay]` line including the per-child ex-style transitions, and
`baseline.png` / `after.png` are the two frames the diff compared. In the verdict,
**`bandChangedPct` near zero means the overlay painted nothing, and a large
`innerChangedPct` means it is opaque** — the second is what the ≤ 1.5.5 sweep does.
`--mode transparent+layered` re-takes that evidence on demand; it is not run in CI.
`pointHitsOverlay: false` is the *healthy* reading: a click-through overlay is meant
to be skipped by hit-testing, so the point lands on whatever is underneath.
`childrenWithLayered > 0` in the default run would mean the #314 fix is not holding.

The driver duplicates launch-smoke's launch/marker/kill sequence rather than sharing
it. Launch-smoke gates every release on three platforms; moving it to serve a probe
buys nothing and risks that.

### The tray rescue leg

The pixel diff says whether the overlay drew itself correctly. It says nothing about
whether it can be *taken down* — and that is the other half of R29, because the
overlays are `closable(false)`, `skip_taskbar(true)` and undecorated, so the tray's
**Close Overlays** item is the only surface left when one misbehaves.

After the probe, the driver touches a second file, `<trigger>.close`. The same
debug-only watcher calls `close_all_overlays` — the exact function the tray item
calls, on the main thread it calls it from — waits 1.5 s for the queued `close()` and
`show()` to land, and logs:

```
[smoke-overlay] rescued overlays=0 main_visible=true
```

`overlays` counts **visible** windows other than `main`. Visible, not merely present:
the tray item *hides* the LED control popup rather than closing it, and a hidden
window covers nothing. Under `--gate` the run fails unless that count is 0 and
`main_visible=true`; a timeout waiting for the line means `close_all_overlays` never
returned, which is a wedged main thread rather than a slow one.

## The CI platform bench

Two more hooks reuse the same idea — a `#[cfg(debug_assertions)]` function, armed
only by an environment variable, reporting one parseable log line — to answer
questions that need a machine nobody on the project owns: a Credential Manager, a
Secret Service, a Windows compositor. They live in `src-tauri/src/smoke_bench.rs` and
ride inside the ordinary launch smoke, which grew `--expect` for exactly this.

Every hook is armed by `<VAR>=1`. Anything else, including an empty string, leaves it
off and logs a warning — CI `env:` blocks make an empty value easy to produce by
accident, and an accidental capture probe costs a screen-recording prompt.

| Hook | Variable | Proves |
|---|---|---|
| Credential round-trip | `LUMASYNC_SMOKE_CREDENTIALS=1` | The OS keychain stores, returns and deletes a secret — Windows Credential Manager and Linux Secret Service, the two backends the maintainer's machine cannot reach |
| Capture probe | `LUMASYNC_SMOKE_CAPTURE=1` | One real frame comes back from the live capture path at the size the downscale policy promises |
| Overlay rescue | `LUMASYNC_SMOKE_OVERLAY_TRIGGER=<path>` | The tray teardown path still empties the screen (above) |

### Reading the credential line

```
[smoke-cred] backend=keychain roundtrip=ok set=12 get=3 delete=8
[smoke-cred] FAIL step=verify backend=keychain detail=read-back differs: wrote 30 bytes, read 0 bytes
```

Timings are milliseconds. The account is `__lumasync_smoke_roundtrip__`, deliberately
unlike any real one (`hue-app-key`, `hue-client-key`), and it is deleted on every path
out of the hook including the failing ones — a leaked entry outlives the process and
on Windows shows up in the user's Credential Manager.

**`backend=` is the whole point of the line.** A debug build seeds `DevFileStore` in
`setup` so `bun run tauri dev` stays out of the OS keychain, so the hook on its own would
happily round-trip a JSON file and report success. The CI step therefore also sets
`LUMASYNC_DEV_USE_KEYCHAIN=1`, and the expectation is on the full
`backend=keychain roundtrip=ok` rather than on `roundtrip=ok` — that pairing is what
makes the result a statement about the OS keychain instead of about a temp file.

`step=` names which of set / get / verify / delete / verify-gone failed.
`verify-gone` failing — the entry surviving its own delete — is the one worth reading
twice: it means the backend is not writing through, and every credential the app
thinks it revoked is still there.

### Reading the capture line

```
[smoke-capture] frame=640x360 pixels=230400 avg=31,28,44 borders=0.0000,0.0000,0.0000,0.0000 ms=412
[smoke-capture] SKIP code=AMBILIGHT_CAPTURE_PERMISSION_DENIED
[smoke-capture] FAIL code=AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND
```

`frame=` is the size *after* the platform's downscale, which is the number GAP 3 and
backlog #234 are about: macOS asks SCStream to scale on the GPU, Windows does the same
arithmetic on the CPU, Linux does it per pull. A line reporting the panel's native
resolution is the gap, quantified, rather than asserted.

The first local run put a number on something the prose had rounded off. All three
paths divide by an **integer** factor (`MAX_CAPTURE_DIM / longest side`, floored, min
1), so "capped at 640 px" is really "capped at 640 px only when the ratio happens to
land on one". A 1800-px-wide display divides by 2 and captures at **900×584** — 1.98×
the pixels of a true 640-px cap, on every frame. The cap is a ceiling of 1279 px in
the worst case, not 640. Worth knowing before anyone reads a Windows frame size as
proof of parity.

`borders=` is `top,right,bottom,left` as fractions, from the same
`detect_black_borders` the live worker runs, at the same threshold —
`BLACK_BORDER_THRESHOLD` lives beside the detector in `ambilight_capture.rs` precisely
so the probe and the worker cannot drift apart and produce incomparable answers. `avg=`
is the mean RGB over every sampled pixel; on a headless runner it is usually the
desktop background, and a flat `0,0,0` with no borders detected means the compositor
handed back an empty surface.

The probe runs on its own thread and drops the frame source there. That is not
tidiness: the macOS branch holds an `SCStream`, and dropping one on the main thread
deadlocks against its own dispatch queue — the same rule `LightingWorkerRuntime::stop`
follows.

It also polls for the first frame rather than calling `capture_frame()` once. macOS
SCStream and Windows WGC both push into a shared slot from their own callback, so a
single call straight after construction reliably loses the race and answers
`AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE` — the live worker just polls past it, and the
first version of this probe reported it as a failure of the platform when it was a
failure of its own timing. Five seconds, 100 ms apart; anything other than "not yet"
is terminal, because a denied permission does not become granted by asking again.

**Screen-recording consent denied is a SKIP, not a FAIL.** It is a true statement about
the machine, and a runner that cannot grant TCC must not turn the build red for saying
so.

### `launch-smoke.mjs --expect`

The bench needs the app to stay alive past the startup marker, which is the one thing
launch-smoke was built not to do. Three repeatable flags, all inert unless passed:

- `--expect <substring>` — hold the app open until it appears in stdout + log, then fail if it never does
- `--expect-soft <substring>` — the same wait, but a warning instead of a failure
- `--expect-fail <substring>` — fail the moment it appears; defaults to `] FAIL`, which every bench hook emits, once any of the three is in use

Bounded by `LAUNCH_SMOKE_EXPECT_TIMEOUT_MS` (30 s default). Every `[smoke-*]` line is
printed on the way out whether the run passed or failed — a green run with no evidence
in the log is how a silently-disabled hook survives.

**With none of the three passed, not one line of this executes.** The whole block is
behind a single `if`, and the release-gate path through the script is what it was
before the flags existed. That matters more than the feature does: this script is what
stands between a broken binary and a published release on all three platforms.

### What each runner is asked for

- **Windows** — both hooks, both gating. This runner is the only Windows desktop the app ever reaches, so Credential Manager and Windows Graphics Capture get proved here or nowhere.
- **Linux** — capture and credentials both gate (the credential leg was soft until its first green run on 2026-08-18: `backend=keychain roundtrip=ok set=714 get=2 delete=6`, and Xvfb capture came back `640x512` from a 1280×1024 screen — the integer downscale at work). The Secret Service is started by hand for the run: `dbus-run-session` wraps everything (so `gnome-keyring-daemon` and the app share one session bus — the daemon claims `org.freedesktop.secrets` on it, which is what keyring 4's `zbus-secret-service` backend talks to), `printf "\n"` unlocks the freshly created login keyring with an empty password, and `xvfb-run` nests inside because it only sets `DISPLAY`.
- **macOS** — capture only, and soft: `--expect-soft "[smoke-capture]"` on the bare prefix, so a frame and a permission SKIP both satisfy it and both get printed. No credential run at all — a Keychain ACL prompt has nobody to answer it, which is the same wall described under "Keychain prompts in dev" below.

## Keychain prompts in dev

macOS asks for the login-keychain password on almost every `bun run tauri dev` start —
*"lumasync wants to use your confidential information stored in com.lumasync.app"* — and
**"Always Allow" does not stop it**. Nothing in the credential code is at fault, and the
number of reads is already down to one per account per process (`CachedStore`).

The cause is the signature. Rust's linker ad-hoc signs every relink, and an ad-hoc
signature's designated requirement is the binary's own cdhash:

```
Signature=adhoc
designated => cdhash H"70177a2d4f4f84335b433dbf0fd33c5a39e33005"
```

"Always Allow" writes *that requirement* into the item's ACL, so the grant belongs to one
build. The next relink is a different program as far as macOS is concerned. Four days of
development left 24 dead grants on `hue-app-key`, each one reporting `status -2147415734`
against a binary that no longer exists.

That ACL is not the gate, though, and fixing it does not stop the prompt. **Two attempts were
measured against a running app and both failed** — recorded here so the next person does not
spend the afternoon again:

- **Re-signing every dev build with a fixed self-signed certificate.** This works as far as it
  goes: the requirement becomes `identifier "…" and certificate leaf = H"…"`, it survives a
  relink byte-identically, and the ACL ends up with one live entry instead of a growing pile of
  dead ones. The prompt still appeared on every build.
- **Clearing the item's partition list** (`security set-generic-password-partition-list -S ""`).
  This made it worse — two prompts became three. macOS re-populates the list on first access and
  asks for the password in order to do so.

The binding gate is the **partition list**, and its entries name a code-signing partition:
`apple:`, `apple-tool:`, `teamid:<TEAMID>`, or `cdhash:<hash>`. Code that carries no team
identifier gets `cdhash:`, which is new on every relink, and there is no wildcard partition to
fall back to. A self-signed certificate does not supply a team identifier either — setting `OU`
on one and signing with it still reports `TeamIdentifier=not set`.

So an ad-hoc or self-signed dev binary will be asked once per build per item, and the two Hue
secrets are two items: `hue-app-key` on the first CLIP v2 call at startup, `hue-client-key` when
a lighting mode opens the DTLS stream. **Only a Developer ID certificate removes it**, because
only that makes the partition `teamid:` and therefore stable.

**So debug builds stopped asking the keychain anything.** `lib.rs` seeds the credential store with
a `DevFileStore` — plaintext JSON, `0600`, in the app data dir — before any Hue command can run, so
a dev session never reaches Keychain Services, and the CI launch smoke's debug binary touches
neither a keychain nor D-Bus. The cost is that a debug build cannot see credentials a release build
stored: a dev session pairs the bridge once and keeps it in its own file. `LUMASYNC_DEV_USE_KEYCHAIN=1`
skips the seeding for anyone who needs the real path back. The consequences for the wire label are
in [`hue.md`](hue.md).

**Released builds have the same defect, and there it reaches users.** `tauri.conf.json` sets no
`signingIdentity` and no workflow carries `APPLE_*` credentials, so shipped macOS builds are
ad-hoc signed as well and their identity changes with every version. A user who has paired a
bridge is asked again after each update — twice, for the same two items. That per-item cost is
why Hue bridge certificate pins are a file in the app data dir rather than keychain items (see
[`hue.md`](hue.md)): a pin per bridge would have added a prompt per update. That is the strongest
argument for Developer ID signing, and it is a user-facing one rather than a developer
convenience.

## Accepted risks

- **Windows embedded-debug launch needs a visible smoke window.** Reproducing [#181](https://github.com/voyvodka/LumaSync/issues/181) on bare-metal Windows isolated a WebView2 race: `tauri dev`, release `--no-bundle`, and the release MSI load, but a debug embedded webview starting hidden falls through to `chrome-error://chromewebdata/`. Disabling the automatic DevTools window does not change it; starting the same binary visible makes the custom-protocol document and frontend IPC load. Production remains hidden to avoid a startup flash. CI merges `tauri.windows-smoke.conf.json`, which changes only the smoke window to visible and disables DevTools. The apparently separate missing frontend logs were a logger-filter bug: plugin-log's `webview:<location>` target does not inherit fern's `level_for("webview", Info)`, because fern only walks `::` module separators. Debug logging now uses a global `Info` floor, allowing the startup marker to reach the file sink. (plugin-log 2.9.2 changed the target to `webview::<location>`, so a `level_for("webview", ..)` would now match; the global floor stays.)
- **The updater signing key is visible to the whole build.** `TAURI_SIGNING_PRIVATE_KEY` is set on the `tauri-action` step, and that step also runs the frontend build and `cargo build`, so every npm script and every crate's build script in the dependency tree runs with the key in its environment. Pinned actions and the pre-publish signature check narrow the exposure but do not remove it. The fix is to build unsigned and sign in a separate job behind a protected environment with a required reviewer; that needs repository settings, and until it lands this is the release pipeline's largest exposure.
- **The `.deb` is not launched in CI.** The release Ubuntu job has every webkit/gtk dev package installed, so installing it there resolves trivially and proves nothing about declared runtime dependencies on a clean machine. Testing it honestly needs a clean container.

## Resolved

- **v1.5.2 shipped a macOS build that could not launch** ([#115](https://github.com/voyvodka/LumaSync/issues/115)). Linking with a deployment target below 12.0 made dyld abort at launch on users' machines. An app that cannot start cannot run its own updater, so the fault was unrecoverable by the mechanism that exists to recover from faults, and affected users had to reinstall by hand. The deployment-target pin, `scripts/verify/macos-swift-runtime.sh`, and the entire launch smoke test all exist because of this one incident. [#179](https://github.com/voyvodka/LumaSync/issues/179) stays open and pinned on purpose: it is the notice for users stranded on 1.5.2, not a defect to close.

## The e2e suite

`bun run e2e` drives the real app through an embedded WebDriver server, and what that layer can
and cannot prove — including the three blind spots that return a clean empty result rather than
failing — is in [`testing-and-verification.md`](testing-and-verification.md).
