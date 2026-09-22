# Philips Hue

Everything about driving a Hue bridge that the code cannot tell you itself. Several of these are
protocol limits rather than preferences — changing them breaks the stream rather than tuning it.

Implementation lives in `src-tauri/src/commands/hue/`, the contract in
`src/shared/contracts/hue.ts`, and the frontend state in `src/features/hue/`.
**That module holds no UI** — the Hue screens are in
`settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx` — which list channels and own
the bridge sync, but do not place them; that is the room map's, and only the room map's.

## Decisions

**The streaming interval floor is 50 ms (20 Hz).** `HUE_SENDER_MIN_INTERVAL_MS` in
`commands/hue/sender.rs`. Going faster does not give a faster response — the bridge throttles and
drops the stream. Treat it as a protocol constant.

**Transport is HTTPS-first with an HTTP fallback.** Bridge Pro serves its local API over HTTPS
only, so pairing, IP verification, and credential validation must try HTTPS before falling back
for older bridges. A plain-HTTP-only client silently fails to reach a Bridge Pro and the failure
surfaces as a generic pairing error on a bridge that discovery found without trouble.

**Only a 401 or 403 carrying a Hue-shaped auth body means the credential is dead.** Any other
failure is a transport problem. Re-pairing on a timeout or a 5xx destroys a working pairing and
forces the user back to the link button for no reason.

Both halves of that rule are load-bearing (`classify_status` in `commands/hue_http.rs`). CLIP v2
documents 401 alongside 403 for a rejected application key, so keying on 403 alone misses a real
re-pair. And the body check is not belt-and-braces: a reverse proxy or a captive portal in front
of the bridge answers with its own 403, and treating that as a dead credential throws away a
pairing that was fine.

**"Hue-shaped" includes the bridge's HTML page, because real bridges do not send JSON here.** On a
BSB002 (fw 1978293000, API 1.78.0, checked 2026-09-23) CLIP v2 with a bogus or missing
`hue-application-key` answers `403`, `Content-Type: text/html`, with a ~0.4 KB page titled
"hue personal wireless lighting" ("Oops, there appears to be no lighting here"). The OpenHue spec
documents a JSON `{"errors":[…]}` body for 401/403, and that path is kept for any firmware that
sends it — but a JSON-only rule meant a revoked key never reached re-pair on the bridge most users
own: readiness logged `HUE_TRANSIENT: HTTP 403 — <!DOCTYPE HTML…`, the start gate showed Off, and
the status bar said OK. The HTML page is accepted only when **every** term holds
(`is_bridge_auth_page`): status 401/403, an HTML content type, that exact `<title>`, a body under
4 KB, and a final URL — after any redirect reqwest followed — that is still an IPv4 literal on
`/api…` or `/clip/v2/…`. A captive portal redirects to its own host and fails the last term; a
proxy page does not carry Signify's title. Something that impersonates the page *from the bridge's
own address* could equally forge the JSON body, so this admits nothing the JSON rule did not.
Home Assistant's `aiohue` goes further and treats any CLIP v2 403 as unauthorized; we do not.

**Credential validation reads `GET /clip/v2/resource/bridge`, never v1 `/api/<key>/config`.** The
bridge answers the v1 config for *any* key with its public subset, `bridgeid` included, so that
probe validated a bogus key ("Hue credentials validated" in the log, `HUE ● OK` in the status bar).
The v2 bridge resource is served only to a working key; a refusal comes back through the
classifier as `HUE_CREDENTIAL_INVALID`, which `useHueBridgeReachability` and the boot validation
already route to the re-pair card. A 2xx is valid only with a `data[].bridge_id`; a 2xx carrying a
v1 `error.type 1` envelope or a v2 auth `errors[]` is still a refusal.

**The HTTP fallback must never run on a request whose response carries a secret.** The pairing POST
returns the DTLS `clientkey`: if that call fell back on a TLS failure the way IP verification does, an attacker who blackholes TCP/443 could force the downgrade and read the
pre-shared key off plain HTTP. `send_clip_v1`'s `allow_http_fallback` flag is `true` only for IP
verification (`/api/config`) and `false` for pairing (credential validation is CLIP v2 and never
goes through `send_clip_v1`), and the fallback itself only triggers on a connect-level failure — a TLS handshake failure
stays fatal, because that handshake failure is exactly the signal such an attacker manufactures.

**Credentials live in the OS keychain, not in the state file.** macOS Keychain, Windows CredMan,
Linux Secret Service, via `commands/hue/credential_store.rs`. `shell-state.json` holds neither the
DTLS pre-shared key nor the application key — on a platform where the keychain works. Where it does
not (a Linux box with no D-Bus), `default_store()` degrades to `NoopStore` and both keys stay on
disk, because the alternative is an app that cannot pair.

**`default_store()` is one process-wide handle with a read cache, and writes evict it.** Every
resolver call used to allocate a fresh probe entry and re-read the backend, which on a single stream
start meant two probes and four keychain reads for two accounts — and on macOS each read is another
chance for the Keychain ACL prompt. `CachedStore` holds each successful read for the process
lifetime. Three rules keep that safe, and the tests in `credential_store.rs` fail without any of
them: a write **evicts** rather than populates, so `migrate_hue_credentials_to_keychain` still
proves itself against the real backend instead of comparing a value to itself; errors are never
cached, so one flaky D-Bus call cannot pin the session to the plaintext fallback; and a read that
raced a write is discarded via a generation counter, because a stale key surviving a re-pair is
worse than the reads the cache removes. The accepted cost: a credential edited outside the app is
not seen until restart.

So the nine `effective_hue_app_key` call sites are **not** nine components each resolving
independently — they all go through that one cached handle, and an unpaired launch costs one
backend read, not nine. What an unpaired launch *does* produce is several identical
`[hue-cred] no application key available` lines within a second, which reads like a loop until you
know that. `resolve_hue_app_key` is `#[track_caller]` so the line names the command that asked;
that attribute has to stay on `effective_hue_app_key` too, or every line reports the wrapper
instead.

**A debug build does not use the OS keychain at all.** `lib.rs` seeds the shared store with a
`DevFileStore` — a plaintext JSON file, `dev-credentials.json`, `0600` in the app data dir —
before any Hue command can run. The reason is the macOS keychain prompt on every `bun run tauri dev`
relink, which nothing on the keychain side fixes; see `build-and-release.md`. Three consequences,
and they are the whole cost: a debug build cannot see credentials a release build stored, so a dev
session pairs the bridge once and keeps it in the file; the file is plaintext, which is the right
trade for a developer convenience on a developer's machine and would only look safer encrypted
under a key stored beside it; and the CI launch smoke's debug binary now touches no keychain and no
D-Bus at all. `LUMASYNC_DEV_USE_KEYCHAIN=1` skips the seeding when the real keychain path is what
needs exercising.

`MigrationOutcome::backend` therefore reports the store's own label rather than a constant
`Keychain`, and the new `dev-file` value is additive on the TS `HueCredentialBackend` union. It
reads exactly like `plaintext-legacy` on the frontend: only the literal `"keychain"` licenses
deleting the plaintext copy, and licensing that on a file no release build can read would strand
the pairing.

**An empty `username` on the wire means "resolve from the OS keychain".** Same idiom as
`clientKey`, applied to the second secret so there is one rule rather than two. Every CLIP surface
runs the request value through `effective_hue_app_key` first; a non-empty value is used as-is and
remains the legacy fallback. Resolving nothing yields `AUTH_INVALID_RE_PAIR_REQUIRED` rather than a
new status code — a new code would fall through every shipped `switch` into the default branch and
render the wrong card, so the "we never called the bridge" distinction is carried in `details`.

**`start_hue_stream` and `restart_hue_stream` resolve before anything else runs.** The overwrite of
`request.username` sits above the readiness call and above the `credentials_valid` gate evidence,
which is computed from that same field. Resolving after either one makes an empty request username
refuse the start with no error the user can act on. Everything downstream is then free: the stored
`ActiveHueStream.username` carries the resolved key, so `stop_hue_stream`, `get_hue_stream_status`,
the deactivate PUTs and the whole reconnect monitor need no credential handling of their own.

**The app-key lookup is a sibling of `resolve_hue_credentials`, not a relaxation of it.**
`resolve_hue_app_key` accepts a keychain holding only the application key; `resolve_hue_credentials`
must keep refusing that shape, because a `Keychain`-labelled result with an empty `client_key` would
drive the DTLS handshake into a PSK negotiation with no key — a hard connect failure replacing a
working legacy path. The ~10 lines of overlap are the price of not touching the DTLS path inside a
credential change.

**The entertainment-area snapshot is cached process-wide, single-flight.** Two independent frontend
polling loops converge on the same bridge payload through different commands — the App health
reconciler via `get_hue_stream_status`, the Devices-tab loop via `check_hue_stream_readiness` — and
the frontend coalescer can only dedupe *within* one command, not across both. `area_cache.rs`
removes the duplication on this side of the IPC boundary instead: a caller arriving mid-fetch waits
on the slot and reuses the leader's result, a bridge-side mutation bumps a generation counter so a
fetch issued before it can never be served after, and every read gating a mutation asks for `Force`
to bypass the cache outright.

**The area-cache TTL is derived, not tuned — 1.5 s.** `HUE_AREA_CACHE_TTL_MS` in `area_cache.rs`.
The co-firing this cache exists to remove lands within ~1.1 s of itself every few ticks, and the
next arrival after that is >2 s away either way, so any TTL at or above ~1.1 s catches all of it and
a larger one catches nothing more. 1.5 s also matches the frontend's own accepted staleness for the
same data (`HUE_READINESS_MAX_AGE_MS`), so this layer never becomes the staleness bottleneck.
Worst-case composed staleness is 3.5 s — below the 5 s health-poll period and well under the
bridge's ~10 s entertainment inactivity close. The value is purely observational: stream liveness is
read from the local `is_shutdown_signaled` probe and the reconnect monitor, never from this cache.

**Colour is clipped per-bulb to its gamut.** Hue bulbs come in gamuts A, B, and C, and a colour
outside a given bulb's triangle is not merely inaccurate — the bridge clamps it somewhere
unpredictable. Clip on our side so the result is deterministic.

**Zones are Hue-only.** The v1.5 W4-F unification collapsed a generic `Zone` discriminated by
`zoneType` back to `HueZone` alone. "Logical zone" was dropped because nothing in the field models
a name plus a channel-index list as a free-standing object — everyone models screen rectangles,
spatial 3D positions, or sink-internal addressing — and it confused users across two rounds of
testing. `ScreenZone` and `LedZone` will land later as separately prefixed types sharing no
discriminator with `HueZone`; a bare `Zone` is ambiguous across three industry namespaces.

**`RoomMapConfig.zones` is the only zone array anything renders.** The deprecated `hueZones` field
is a migration *input*, not a second store. Every authoring path — the room-map editor and the
Lights dock alike — writes `zones`.

**Stranded zones are recovered, not dropped.** Through v1.5.4 the Lights dock's "Add Hue zone"
button wrote into `hueZones` at a point when the one-shot `schemaVersion 1 → 2` fold had already
run, so those zones were never rendered and never could be. A `3 → 4` step re-folds them. Reviving
persisted records is normally the wrong instinct — a fold that resurrects something the user
deleted is worse than the original bug — but here nothing in any released build ever displayed
`hueZones`, so a stranded record cannot be one the user chose to delete. The fold still dedupes by
id and reuses `migrateLegacyHueZone`, so a corrupt record is dropped with a warning rather than
half-migrated.

**Background bridge polling gives up; it never re-discovers on its own.** Two frontend loops probe
the bridge while nothing is streaming — `useHueBridgeReachability` (30 s, feeds the "no reachable
output" banner) and `useHueReadinessPolling` (15 s, 3 s while a foreign streamer holds the area).
Both used to retry forever, so a bridge paired on another Wi-Fi network was polled for the whole
session with nothing on screen to say so. They now share one failure budget
(`model/pollBudget.ts`): **4 consecutive failures *and* a 90 s unbroken streak**, after which the
loop stops and the banner offers a manual retry.

Both terms are load-bearing. A count alone gives up after 12 s on the 3 s blocked cadence; a
duration alone gives up on the first failed tick of a slow one. Telling a user their bridge is gone
because the Wi-Fi hiccupped for ten seconds is worse than the over-polling being fixed, so any
success resets the streak — two failures, a success, then two more is not four failures.

Only a bridge that did not *answer* counts (`HUE_CREDENTIAL_CHECK_FAILED`,
`HUE_STREAM_READINESS_FAILED`, or a rejected `invoke`). `HUE_CREDENTIAL_INVALID` and
`HUE_STREAM_NOT_READY` are answers from a reachable bridge, with their own recovery paths (re-pair,
release the area) — counting them would put a "check again" button in front of a problem retrying
cannot fix.

There is deliberately **no network-change listener** and no slow background heartbeat: the app
retries on launch, which covers returning to the right network later. The retry gesture is shared
through a module store (`state/huePollRestart.ts`) because the two loops live in different React
trees from the control that re-arms them.

**Hue is not retried in the background — except once, at launch, for a busy area.** The rule is that
a Hue start the bridge refuses is settled on the spot (Off, or USB alone with a notice) and only the
user or the next launch tries again. The one exception is `mode/state/bootHueRetry.ts`. After an
unclean exit the bridge keeps counting the dead process as the area's streamer for 10–20 s, so a
relaunch inside that window has its restore refused and used to land on Off for no reason the user
could see or fix. When the boot restore ends not running and `start_hue_stream` answered
`CONFIG_NOT_READY_GATE_BLOCKED`, the frontend polls `check_hue_stream_readiness` every 3 s for up
to 25 s and, the moment the area is free, re-runs the mode through the interactive handler — once.

- **Busy is decided by readiness, not by the start code.** The gate code also covers an unreachable
  bridge and an unusable area, and its `details` only name the missing prerequisite. Busy means
  the readiness reasons are exactly the `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` sentinel; any other
  answer (unreachable, re-pair, no channels, area gone) ends the wait at the first probe, before
  any notice shows. An auth code from the start never qualifies at all.
- **Boot only, Off only.** A restore that ran on USB with Hue left out keeps the existing notice
  and is not retried; the interactive paths never schedule it.
- **The user always wins.** Any lighting-mode choice, deselecting Hue, or any `stopHue` call cancels
  the wait. The last is attached to the command wrapper in `modeApi.ts`, the same way
  `stop_hue_stream` cancels the backend's own reconnect retry. The waiting notice says lighting will
  resume by itself; if the window closes first a second notice says it stayed off.

## Gotchas

- **Hue `+y` is the TV wall, and it is drawn at the *top* of the room-map canvas.** `x` is left/right, `y` is depth with `+1` at the screen and `-1` behind the viewer, `z` is height. Three comments in `HueChannelOverlay.tsx` used to say `+y` was the canvas *bottom*; the code never agreed with them — `hueToMetres(-worldY, …)` maps `+1` to `0 px`. No first-party Signify statement is quotable here: the Entertainment reference is behind a developer-portal login and OpenHue types the field with no description, so the axis is established from two independent implementations — diyHue synthesises the TV-mounted gradient strip at a constant `y = 0.8`, and HyperHDR treats `y >= 0.75` at TV height as the screen's own edge. Note also that without a TV anchor the runtime collapses this depth axis onto screen *vertical*: `+y` samples the top of the screen, `-y` the bottom. With one, height (`z`) picks the vertical band instead and depth only feeds the ambience blend — see `room-map.md`. Anything naming that axis must therefore name it for the room (far/near), not for the screen.
- **`get_hue_area_channels` does not always answer with the bridge's own numbers.** It has a fast path (`channels_to_info_via_owner`) that serves the running stream's channel list instead of fetching, and that list is the one `apply_channel_placements` overwrote with the user's local placements before `store_active_stream_context` stored it. The persistent sender does the same for a solid-colour session. So **while lighting is on, the "bridge positions" it returns are ours**, and any code comparing local placement against them compares our numbers with themselves — reporting "in sync" most confidently at exactly the moment a user is looking. That is why the bridge-sync state is derived from a persisted snapshot of what was last pushed (`ShellState.hueBridgeSyncedPositions`, per area) rather than from a read, and why both push and pull are gated on the runtime being idle: the same fact that rules out the read rules out adopting a list fetched mid-stream, which would pull our own placements back and look like it worked.

- **A channel's position is written through `locations`, never through `channels`.** A PUT carrying `channels` is refused with HTTP 400 (`Property [channels] cannot be specified for this request type`) — checked on a real bridge on 2026-09-23 — so until then "Save to bridge" had never saved anything. The official CLIP reference describes a channel's `position` as *the average position of its members*: it is derived, and the writable source is `locations.service_locations[].positions`, one entry per entertainment service. `update_hue_channel_positions` therefore GETs the area, replaces positions inside the full list, and PUTs the whole list back (the bridge answers 200 and re-derives the channel, quantising the value slightly). The mapping is taken only when it is unambiguous: the channel has exactly one member, that member is segment `index` 0, no other channel references the same service, and the service has exactly one position. Anything else — a gradient strip (two positions spread over several segment channels, which the bridge interpolates), a channel grouping several services — is skipped and reported, never approximated; the lights beside it still save. A height of unknown origin (`zOrigin` absent) keeps the bridge's own `z` rather than writing the seeding placeholder. A 2xx whose `errors[]` is non-empty counts as a rejection, and a Hue-shaped 401/403 on either request is the usual re-pair signal. A 404 is the area itself gone (deleted in the Hue app, or an id from another bridge) and answers `CHAN_WB_AREA_NOT_FOUND`, not a network error. The command is `async` and runs its keychain read and two blocking HTTP calls on the blocking pool: as a sync command Tauri ran it on the main thread, and the window froze for up to ~10 s against a slow bridge.

- **Placement is authored in one place, and it is the room map.** The Devices page carried a drag pad, then five coarse presets; both are gone. It lists what the bridge reports — the channel's own id, its bulb count, its zone — and owns the bridge sync, because that is bridge-side. Two writers for one value is what the earlier surfaces were, and the smaller of the two could not express distance and height in metres, which is what placement is for. The room map fetches the channel list itself (`useRoomMapHueChannels`) rather than waiting for the Devices page to have been opened; seeding is shared between both surfaces through `room-map/model/hueChannelSeeding.ts` so they cannot disagree about which channel is which.

- **`hueCredentialEvents.ts` exists because pairing is invisible to everything outside `useHueOnboardingCore`.** App owns the `hueStartConfig` mirror — the projection the reachability probe and the USB reconciler both read — and until this bus it was written on boot and on a lighting-mode change and nowhere else. So pairing a bridge, or picking an area, left every one of those consumers on `null` until the user happened to switch modes. Subscribers deliberately re-read `shellStore` rather than trusting a payload: no single emit site holds the whole projection (pairing knows the bridge and credentials but not the area; area selection knows the reverse), and a diff assembled from partial knowledge is how the mirror drifts. Emit *after* the write resolves, never beside it — firing early hands the subscriber the value the write is replacing. Third bus of this shape, after `connectionEvents.ts` and `firmwareProfileEvents.ts`; when a fourth is needed, the shared-instance question in `device-output.md` is the one to reopen instead.
- **Hue availability is read from the live stream, so a test pattern started with the mode off sees no bridge.** `start_led_test_pattern` asks `snapshot_hue_output_context`, which answers only while `active_stream` is `Some`. USB and WLED are read from the connection and the sink registry, which survive a mode change — so the same run reports a disconnected strip as available and a paired, reachable bridge as absent, and degrades to preview-only. Rust cannot close the gap alone: opening a stream needs the bridge address, the area and the keychain credentials the frontend holds. `features/hue/state/hueTestLease.ts` opens one for the run and stops it afterwards, and it must stop *only* what it opened — `HUE_START_NOOP_ALREADY_ACTIVE` means a live mode or the other webview owns the stream, and releasing that switches off lights the test never turned on. It is module state rather than a hook because LED Setup and the control popup are separate webviews with no shared React tree.
- **A bridge allows one active entertainment streamer at a time.** `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` in the log means something else holds the session — often a previous instance of this app that did not shut down cleanly, or the official Hue Sync app. It is not a pairing failure and must not be reported as one.
- **Our own running stream is not a foreign streamer, and only our own running stream is exempt.** The bridge names the holder only by an `auth_v1` id, and learning ours costs a `GET /auth/v1`, so ownership is read from this process's runtime instead (`streams_area`): state `Running`, an active stream for the same bridge and area, and a sender that has not exited. Only then does readiness (`ActiveStreamerView::Ours`) drop the sentinel — for `get_hue_stream_status`'s health poll and for `check_hue_stream_readiness` from the frontend, which used to report our own area as held by another app and log it every ~5 s. Every gate about to start a session — start, restart, reconnect — passes `Foreign`. A session a previous run left on the bridge holds the area under the *same* key and must keep reading as busy: nobody has shown the bridge accepts a fresh start over it, and the boot retry waits on exactly that sentinel.
- **A gate-blocked start says why in `details`, as tokens.** `start_with_evidence` appends `"; readiness: <readiness code>[, HUE_STREAM_NOT_READY_ACTIVE_STREAMER]"` to `CONFIG_NOT_READY_GATE_BLOCKED`'s details, so the frontend can tell a busy area (the sentinel) from an unreachable bridge (`HUE_STREAM_READINESS_FAILED`) without a new code. A refused key never reaches that branch — it is `AUTH_INVALID_CREDENTIALS` with the `repair` hint.
- **`entertainment_configuration` deactivation can race between three call sites:** the sender thread's own cleanup, the foreground `stop_hue_stream` command, and the reconnect monitor's pre-restart cleanup. Uncoordinated, all three PUT `{"action":"stop"}` to the same area, which the bridge logs as duplicate stale-state mutations and which historically produced the "phantom active streamer" symptom (bug audit A1.3). `DeactivateToken` is the coordination primitive — whichever caller wins `try_acquire()` performs the PUT, every later caller sees the in-flight bit and no-ops. It gates one PUT *in flight*, not one PUT per lifetime: a PUT that fails hands the token back, because what it dedupes is concurrency, and a token burned on a failure means no later caller ever retries and the bridge keeps `active_streamer` until it is restarted. A PUT that succeeds keeps it burned — releasing there would reopen the race. That rule lives in `settle_deactivate`, separately from the HTTP call, so it is testable without a bridge; the log has to live there too, because four of the six call sites discard the `Result`.
- **`DTLS entertainment stream established` is the line that proves streaming actually started.** Pairing succeeding says nothing about the stream.
- **Bug H2 — gamut clipping used to discard luminance, not just chroma.** The fix converts RGB to CIE xy plus the input's own luminance (`big_y`), clips the xy point to the bulb's gamut triangle, then converts back using that *same* luminance rather than a hard-coded 1.0. Before the fix, the inverse transform renormalised so the largest channel saturated — preserving hue but discarding brightness, which the frame builder then tried to claw back through the brightness scalar, producing visibly dim saturated content and, on gamut-edge projections, momentary all-zero RGB that drove the ambilight-frame stutter.
- **Discovery touches the cloud; the manual-IP path does not.** The mDNS/discovery endpoint is the only outbound call in the entire application, and it has a manual fallback precisely so a user can avoid it.
- **A failed read-back rolls back BOTH keychain halves, never just the bad one.** `migrate_hue_credentials_to_keychain` writes, reads back, compares, and only then reports success; on any mismatch it deletes both entries. Deleting only the mismatched half looks tidier and is wrong — `resolve_hue_credentials` prefers a complete keychain pair over the request fallback, so a stale pair left behind shadows the working plaintext credentials and yields a broken bridge that reports a keychain success. Rolling both back degrades to the plaintext path, which works. The order is fixed: write, read back, *then* clear plaintext. Never clear on a write acknowledgement alone.
- **Only the literal `"keychain"` licenses deleting the plaintext copy.** An absent `credentialStorageBackend` — every pairing failure path, and any Rust build predating the migration — means there is no evidence the keychain holds anything, and the only safe response to no evidence is to keep the copy. `CredentialBackend::as_str` can also emit `"noop"`, which is outside the TS union. Test for the one permitting value; never switch exhaustively over the union.
- **"Paired" is `hueAppKey || credentialStorageBackend === "keychain"`, never the app key alone.** The same trap caught the client key one release earlier: a condition that reads a *present secret on disk* as proof of pairing silently reports "unpaired" the moment that secret legitimately moves to the keychain. Both `toHueStartConfig` and the `useHueOnboardingCore` boot restore carry the two-armed predicate; getting it wrong there kills Hue at boot and on every seamless target switch with no status code and no toast, because both call sites read `null` as "no bridge configured" and skip. The empty username and client key they pass downstream are exactly what make Rust resolve from the keychain.
- **Credential cleanup is not a store migration.** `migrateShellState` is a pure function with no Tauri access, so it can never prove the keychain holds a copy before deleting the plaintext one — on a machine with a locked or unavailable keychain that would destroy the pairing. The one-shot cleanup for old installs is a Tauri command called at boot instead, and it clears nothing unless the response comes back `keychain`.
- **A Hue command's `Result` is structural, not a throwing surface.** Every command in `commands/hue/commands.rs` returns `Ok` on every path; coded failures ride the status object. The `Result` cannot simply be narrowed away either — Tauri fails an `async` command that takes a reference (`State<'_, _>`) and does not return one, with an `AsyncCommandMustReturnResult` trait-bound error. `get_hue_area_channels` is the shape to copy: `{ status, channels }`, `channels` empty on every failure arm, and `HUE_AREA_CHANNELS_EMPTY` kept distinct from `HUE_AREA_CHANNELS_FAILED` so an area with no lights never reads as an unreachable bridge.
