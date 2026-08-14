# Philips Hue

Everything about driving a Hue bridge that the code cannot tell you itself. Several of these are
protocol limits rather than preferences — changing them breaks the stream rather than tuning it.

Implementation lives in `src-tauri/src/commands/hue/`, the contract in
`src/shared/contracts/hue.ts`, and the frontend state in `src/features/hue/`.
**That module holds no UI** — the Hue screens are in
`settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx`.

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

**The HTTP fallback must never run on a request whose response carries a secret.** The pairing POST
returns the DTLS `clientkey`: if that call fell back on a TLS failure the way IP verification and
credential validation do, an attacker who blackholes TCP/443 could force the downgrade and read the
pre-shared key off plain HTTP. `send_clip_v1`'s `allow_http_fallback` flag is `false` for that one
call, and the fallback itself only triggers on a connect-level failure — a TLS handshake failure
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

## Gotchas

- **`commands/hue_stream_lifecycle.rs` is a re-export shim.** The implementation moved under `commands::hue::*`. Import paths still resolve through it; do not add new code there.
- **A bridge allows one active entertainment streamer at a time.** `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` in the log means something else holds the session — often a previous instance of this app that did not shut down cleanly, or the official Hue Sync app. It is not a pairing failure and must not be reported as one.
- **`entertainment_configuration` deactivation can race between three call sites:** the sender thread's own cleanup, the foreground `stop_hue_stream` command, and the reconnect monitor's pre-restart cleanup. Uncoordinated, all three PUT `{"action":"stop"}` to the same area, which the bridge logs as duplicate stale-state mutations and which historically produced the "phantom active streamer" symptom (bug audit A1.3). `DeactivateToken` is the single-shot coordination primitive — whichever caller wins `try_acquire()` performs the PUT, every later caller sees the in-flight bit and no-ops.
- **`DTLS entertainment stream established` is the line that proves streaming actually started.** Pairing succeeding says nothing about the stream.
- **Bug H2 — gamut clipping used to discard luminance, not just chroma.** The fix converts RGB to CIE xy plus the input's own luminance (`big_y`), clips the xy point to the bulb's gamut triangle, then converts back using that *same* luminance rather than a hard-coded 1.0. Before the fix, the inverse transform renormalised so the largest channel saturated — preserving hue but discarding brightness, which the frame builder then tried to claw back through the brightness scalar, producing visibly dim saturated content and, on gamut-edge projections, momentary all-zero RGB that drove the ambilight-frame stutter.
- **Discovery touches the cloud; the manual-IP path does not.** The mDNS/discovery endpoint is the only outbound call in the entire application, and it has a manual fallback precisely so a user can avoid it.
- **A failed read-back rolls back BOTH keychain halves, never just the bad one.** `migrate_hue_credentials_to_keychain` writes, reads back, compares, and only then reports success; on any mismatch it deletes both entries. Deleting only the mismatched half looks tidier and is wrong — `resolve_hue_credentials` prefers a complete keychain pair over the request fallback, so a stale pair left behind shadows the working plaintext credentials and yields a broken bridge that reports a keychain success. Rolling both back degrades to the plaintext path, which works. The order is fixed: write, read back, *then* clear plaintext. Never clear on a write acknowledgement alone.
- **Only the literal `"keychain"` licenses deleting the plaintext copy.** An absent `credentialStorageBackend` — every pairing failure path, and any Rust build predating the migration — means there is no evidence the keychain holds anything, and the only safe response to no evidence is to keep the copy. `CredentialBackend::as_str` can also emit `"noop"`, which is outside the TS union. Test for the one permitting value; never switch exhaustively over the union.
- **"Paired" is `hueAppKey || credentialStorageBackend === "keychain"`, never the app key alone.** The same trap caught the client key one release earlier: a condition that reads a *present secret on disk* as proof of pairing silently reports "unpaired" the moment that secret legitimately moves to the keychain. Both `toHueStartConfig` and the `useHueOnboardingCore` boot restore carry the two-armed predicate; getting it wrong there kills Hue at boot and on every seamless target switch with no status code and no toast, because both call sites read `null` as "no bridge configured" and skip. The empty username and client key they pass downstream are exactly what make Rust resolve from the keychain.
- **Credential cleanup is not a store migration.** `migrateShellState` is a pure function with no Tauri access, so it can never prove the keychain holds a copy before deleting the plaintext one — on a machine with a locked or unavailable keychain that would destroy the pairing. The one-shot cleanup for old installs is a Tauri command called at boot instead, and it clears nothing unless the response comes back `keychain`.
- **A Hue command's `Result` is structural, not a throwing surface.** Every command in `commands/hue/commands.rs` returns `Ok` on every path; coded failures ride the status object. The `Result` cannot simply be narrowed away either — Tauri fails an `async` command that takes a reference (`State<'_, _>`) and does not return one, with an `AsyncCommandMustReturnResult` trait-bound error. `get_hue_area_channels` is the shape to copy: `{ status, channels }`, `channels` empty on every failure arm, and `HUE_AREA_CHANNELS_EMPTY` kept distinct from `HUE_AREA_CHANNELS_FAILED` so an area with no lights never reads as an unreachable bridge.
