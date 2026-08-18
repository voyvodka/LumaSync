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

**A tag push is not gated by branch protection, so `release.yml` gates it itself.** Protection rules
apply to pull requests into `main`; nothing stops a tag on any commit, including one that never saw
review. The release job therefore asserts the tagged commit is contained in `main` and was
introduced by a *merged* pull request. Provenance is checked rather than re-running the required
contexts against the merge commit: `ci.yml` sets `cancel-in-progress`, so a superseded commit's run
shows `cancelled` even when its PR was fully green — requiring `success` there would block
legitimate releases. A merged PR cannot exist without the four required checks having passed, which
is the same guarantee arrived at from the other side.

**The version gate also runs on every PR, not only on a tag.** `scripts/verify/version-parity.mjs`
is in `check:all` and applies the same rules as the tag gate — plus two the workflow cannot check
from a tag alone: that `Cargo.lock`'s `lumasync` entry was refreshed by `cargo check`, and that
`CHANGELOG.md` has exactly one heading for the version. Its `sed`/`jq` equivalents are deliberately
copied rather than reimplemented; a check that reads the files differently can pass where the gate
fails, which is worse than no check. Learning at tag time that a version drifted is the most
expensive moment to learn it: the work is already merged.

`release.yml` also runs `typecheck:e2e` and `check:i18n`, the two members of `check:all` it was
missing. `check:i18n` is the orphaned-translation-key ratchet, and a tag push runs no CI, so this is
the only place it can catch one before publication.

## Gotchas

- **`cargo build` and `pnpm tauri build --debug` write the same path and produce different binaries.** Both land on `src-tauri/target/debug/lumasync`. The cargo one loads the frontend from the Vite dev server, so launching it without `pnpm dev` running gives a blank window and `Could not connect to localhost:1420` in the Web Inspector — an intact app with no content, indistinguishable from a broken one. Nothing about the path reveals which is there. Use `pnpm tauri dev`, or rebuild with `--debug --no-bundle` to embed the frontend. `scripts/verify/launch-smoke.mjs` asserts the frontend is embedded and fails immediately rather than waiting out its timeout.
- **`build.rs` embeds `windows-app-manifest.xml` into every linked target**, not just the bin. Test binaries reach comctl32 v6 through tauri's tray/menu stack, and Windows refuses to load them without the manifest (`STATUS_ENTRYPOINT_NOT_FOUND`).
- **CI passes `--test-threads=1` to `cargo test`, and it is not required.** The worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD` mutex shared by both test modules, so the suite passes at default parallelism. The flag predates that guard. Reproduce CI exactly only when chasing a CI-only failure.
- **A green CI run proves the debug binary starts, not the installer.** `scripts/verify/launch-smoke.mjs` launches debug binaries on all three platforms; Windows uses `tauri.windows-smoke.conf.json` because WebView2 can lose the embedded top-level request when a debug webview starts hidden. `release.yml` launches the mounted `.dmg`, the AppImage, and the Windows release binary before the draft is published. The `.msi` and `.deb` installers themselves are not installed in CI.
- **`launch-smoke.mjs --log-file` scans the file from its size at launch and never deletes it.** A stale log would match the startup marker without the app ever starting, so only bytes appended after the script starts count; a file that is *shorter* than it was at launch was rotated or truncated and is read from the top. It used to delete the file instead, which on a developer machine is the live log — and on macOS's case-insensitive filesystem `lumasync.log` and `LumaSync.log` are the same file, so it once destroyed months of history. `overlay-smoke.mjs` follows the same rule.
- **No duplicate `## [X.Y.Z]` headings in `CHANGELOG.md`.** `release.yml` extracts notes with `awk` and stops at the first match.
- **`chunkSizeWarningLimit` is raised to 900 kB, and that is a ratchet rather than a mute.** Vite's 500 kB default measures download cost over a network; a Tauri bundle is read off local disk and never pays it, so the default fired on every build on macOS and Ubuntu and said nothing actionable. The limit sits just above the current bundle so real growth still trips it. Code-splitting the room-map editor would cut startup parse time — that is a genuine win, but a separate change, not a way to silence this.
- **The test environment installs its own `localStorage`** in `src/test/setup.ts`. Node ≥ 24 defines an experimental `localStorage` global that reads back as `undefined` without `--localstorage-file`, and it shadows the one happy-dom provides. CI runs Node 22 and never saw it; on a newer local Node every `HsvColorPicker` recent-colors read and write threw into its own `catch`, so the feature was inert in tests and nothing failed. Anything reached through `window` deserves the same suspicion when local and CI Node versions differ.

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

## Keychain prompts in dev

macOS asks for the login-keychain password on almost every `pnpm tauri dev` start —
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
bridge is asked again after each update — twice, for the same two items. That is the strongest
argument for Developer ID signing, and it is a user-facing one rather than a developer
convenience.

## Accepted risks

- **Windows embedded-debug launch needs a visible smoke window.** Reproducing [#181](https://github.com/voyvodka/LumaSync/issues/181) on bare-metal Windows isolated a WebView2 race: `tauri dev`, release `--no-bundle`, and the release MSI load, but a debug embedded webview starting hidden falls through to `chrome-error://chromewebdata/`. Disabling the automatic DevTools window does not change it; starting the same binary visible makes the custom-protocol document and frontend IPC load. Production remains hidden to avoid a startup flash. CI merges `tauri.windows-smoke.conf.json`, which changes only the smoke window to visible and disables DevTools. The apparently separate missing frontend logs were a logger-filter bug: plugin-log's `webview:<location>` target does not inherit fern's `level_for("webview", Info)`, because fern only walks `::` module separators. Debug logging now uses a global `Info` floor, allowing the startup marker to reach the file sink.
- **The `.deb` is not launched in CI.** The release Ubuntu job has every webkit/gtk dev package installed, so installing it there resolves trivially and proves nothing about declared runtime dependencies on a clean machine. Testing it honestly needs a clean container.

## Resolved

- **v1.5.2 shipped a macOS build that could not launch** ([#115](https://github.com/voyvodka/LumaSync/issues/115)). Linking with a deployment target below 12.0 made dyld abort at launch on users' machines. An app that cannot start cannot run its own updater, so the fault was unrecoverable by the mechanism that exists to recover from faults, and affected users had to reinstall by hand. The deployment-target pin, `scripts/verify/macos-swift-runtime.sh`, and the entire launch smoke test all exist because of this one incident.

## The e2e suite runs against the real app, and its state

`pnpm e2e` builds a debug binary and drives it through the `embedded` WebDriver provider, so a run
opens a real window and switches modes and tabs on screen. It also reads and writes the same
`shell-state.json` the installed app uses — there is no isolated profile.

Two consequences, both of which have already bitten:

- **Nothing runs the suite automatically.** `ci.yml` never invokes `wdio`; `release.yml` runs
  `typecheck:e2e` only, which compiles the specs without executing them. So the suite is exercised
  on a maintainer machine or not at all — which is how it came to encode an assumption that had been
  false for several releases.
- **A spec must not assume a starting state.** `shell.e2e.ts` asserted the app "boots into compact
  mode", which stopped being true when boot began restoring the persisted mode; on a machine last
  left in full, the first three specs failed. Worse, the suite *repaired itself*: the section-routing
  spec ends by switching back to compact, so a second run passed and the failure looked like a flake.
  Assert against the persisted value, or switch to the mode the spec needs.
- **A run is visible and it mutates real data.** Anyone watching the machine sees the app open,
  cycle through menus and close. Say so before running it, and put back anything a spec seeded.
