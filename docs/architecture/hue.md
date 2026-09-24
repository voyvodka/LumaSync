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
`commands/hue/sender/dtls_loop.rs`. Going faster does not give a faster response — the bridge
throttles and drops the stream. Treat it as a protocol constant.

**Transport is HTTPS-first.** Bridge Pro serves its local API over HTTPS only, so every bridge call
goes to HTTPS first; only IP verification may then fall back to plain HTTP for older bridges (see
below). A plain-HTTP-only client silently fails to reach a Bridge Pro and the failure surfaces as a
generic pairing error on a bridge that discovery found without trouble.

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
proxy page does not carry Signify's title. (Bridge clients no longer follow redirects at all, so
the last term now backs up the transport rather than standing alone.) Something that impersonates
the page *from the bridge's own address* could equally forge the JSON body — and would first have
to present that bridge's certificate — so this admits nothing the JSON rule did not.
Home Assistant's `aiohue` goes further and treats any CLIP v2 403 as unauthorized; we do not.

**Credential validation reads `GET /clip/v2/resource/bridge`, never v1 `/api/<key>/config`.** The
bridge answers the v1 config for *any* key with its public subset, `bridgeid` included, so that
probe validated a bogus key ("Hue credentials validated" in the log, `HUE ● OK` in the status bar).
The v2 bridge resource is served only to a working key; a refusal comes back through the
classifier as `HUE_CREDENTIAL_INVALID`, which the health monitor's probe and the Devices view's boot
validation already route to the re-pair card. A 2xx is valid only with a `data[].bridge_id`; a 2xx carrying a
v1 `error.type 1` envelope or a v2 auth `errors[]` is still a refusal.

**The HTTP fallback must never run on a request whose response carries a secret.** The pairing POST
returns the DTLS `clientkey`: if that call fell back the way IP verification does, an attacker who
blackholes TCP/443 could force the downgrade and read the pre-shared key off plain HTTP.
`send_clip_v1` takes a plain-HTTP client (`http_fallback`) only for IP verification
(`/api/config`) and `None` for pairing; credential validation is CLIP v2 over HTTPS and never goes
through it. The fallback itself only triggers on a connect-level failure, and never on a failed TLS
handshake, because that handshake failure is exactly the signal such an attacker manufactures.
reqwest files a TLS failure under `is_connect()` too — the same kind as a closed port — so this was
not true until `send_clip_v1` checked `transport::is_tls_failure` explicitly; a refused bridge
certificate is one such failure.

**The bridge's certificate is checked, not trusted.** Every bridge client used to set
`danger_accept_invalid_certs`, so anything answering on the bridge's address during pairing could
read the application key and the DTLS client key. `commands/hue/bridge_identity.rs` now verifies
each handshake (a `rustls` `ServerCertVerifier`, handed to reqwest as a preconfigured
`ClientConfig`):

- **The CN must be a bridge id** — 16 hex digits, compared lower-case. The square bridge writes it
  lower-case; a real Bridge Pro (BSB003) certificate reads `CN=C42996FFFEC4E2D8, OU=BSB003`, so a
  case-sensitive match would lock every Bridge Pro out. The server name is an IP literal and the
  certificate carries no IP SAN, so ordinary hostname verification has nothing to compare; identity
  is the CN.
- **Signify-signed certificates are anchored** to the two roots Signify publishes in "Using HTTPS"
  (https://developers.meethue.com/develop/application-design-guidance/using-https/ — behind a
  developer login): `C=NL, O=Philips Hue, CN=root-bridge` (2017-01-01 → 2038-01-19, SHA-256
  `F0:BD:8E:65:09:E8:2F:77:4D:63:BC:00:9D:53:88:C9:69:FE:3D:CF:7D:6D:54:1D:63:51:B7:2B:89:8D:8A:CF`)
  and `C=NL, O=Signify Hue, CN=Hue Root CA 01` (2025-02-25 → 2050-12-31, SHA-256
  `D8:B8:94:48:B2:AF:8E:16:76:18:5A:C0:72:19:EE:9D:CB:C8:F0:1C:12:2A:02:6A:2A:4B:7B:5C:FE:03:28:B8`).
  The PEM text was taken from openHAB's Hue binding (`huebridge_cacert.pem`) and openhue-go
  (`certs.go`), which both cite that page, and the two agree byte for byte. Intermediates the
  bridge sends are used for the chain. The Bridge Pro certificate above chains to `root-bridge`.
- **Older bridges sign their own certificate**, so a certificate that does not chain is pinned on
  first use: its SHA-256 is recorded as `{ "kind": "selfSigned", "sha256": "<hex>" }`, and a
  later, different certificate for that bridge id is refused. A bridge that has once shown a
  Signify-signed certificate is recorded as `"kind": "signify"`, and a self-signed one for it
  afterwards is refused as a downgrade — without that record an impostor presenting a self-signed
  certificate under the real bridge id would simply be pinned. A self-signed bridge that later
  presents a Signify-signed certificate (a firmware reissue) is re-recorded as `signify`.
- **Pins are a file, not keychain items.** `hue-bridge-pins.json` in the app data dir
  (`commands/hue/pin_store.rs`), keyed by bridge id, set up in `lib.rs` before any Hue command
  runs. A pin is not a secret; it needs integrity, and anything that can write the app data dir
  already owns `shell-state.json` and the app's own configuration. The keychain would have cost
  more than it protects: an ad-hoc-signed macOS build is asked once per keychain item after every
  update (see `build-and-release.md`), so each bridge would have added a prompt per update, and on
  a Linux box without Secret Service (`NoopStore`) nothing would have been stored at all. The file
  is written atomically (temp file, fsync, rename) under a process mutex; a missing or corrupt
  file reads as no pins, is logged, and never blocks Hue — the next pin written replaces it. The
  keychain keeps what is secret: the application key, the client key, and the pair's owner.
- **Link-button pairing re-learns a changed self-signed pin**, and only that: a factory reset
  regenerates the self-signed certificate, and without this such a bridge could never be paired
  again. Pairing is as trust-on-first-use as the very first pairing was; a `signify` record is
  never relaxed, not even here.
- **A refusal reads as `HUE_BRIDGE_IDENTITY_MISMATCH`** on `verify_hue_bridge_ip`,
  `pair_hue_bridge` and `validate_hue_credentials`; every other command keeps its own failure code
  with the rejection's text (which starts with that token) in `details`. The Devices card shows it as
  a failed pairing with its own explanation, and the reachability probe treats it as an answer that
  needs a re-pair — never as an offline bridge, and never counted against the poll budget.
- **Accepted costs.** First contact is trust-on-first-use for a self-signed bridge, and every
  existing pairing learns its bridge's certificate on the first connection after the update. A
  corrupt pins file, or a process that found no app data dir (pins then last for the session),
  loses the record, so the next contact is first use again; a Signify-signed bridge is still
  checked against the roots either way. The
  handshake signature is verified against the leaf's public key read by openssl
  (`webpki::RawPublicKeyEntity`), not by parsing the leaf with `webpki`, which refuses some
  certificate shapes an old bridge may hold. TLS session resumption is off, because a resumed
  session skips the verifier.

**One transport, bound to the key's bridge.** `commands/hue/transport/` is the only place a
bridge client is built. A client is chosen by what it may send: `*_for_key(app_key)` binds the
connection to the pair's owner (`KEY_HUE_BRIDGE_ID`) when `app_key` is the keychain's own key, so
the handshake fails before the key leaves the machine if anything else answers on that address.
The app-key resolver cannot make that check itself — every caller holds an address, and only the
handshake learns which bridge is there. Clients are cached per trust for the process, so a poll
reuses a pooled connection instead of paying a handshake per tick; they never follow redirects,
refuse plain `http://`, and read at most 1 MiB of a body (`HUE_MAX_RESPONSE_BYTES`). The only
client that can speak plain HTTP to a bridge is IP verification's fallback, which never carries a
key. `validate_bridge_addr` (`transport/address.rs`) is the one address guard: a bare IPv4 literal
in RFC 1918, link-local, or RFC 6598 shared space — no hostname, port, loopback, public, multicast
or broadcast address — so the webview cannot aim a request carrying the key at an arbitrary host.

**The pair belongs to a bridge id, not an address.** Pairing records the bridge id from the
certificate of the pairing answer itself. Releases up to 1.5.5 recorded the bridge's IP address,
and `resolve_hue_credentials` compared it with the address being streamed to — so after a DHCP
renewal the DTLS pair stopped resolving and streaming fell back to HTTP without a word. An
IP-shaped owner is now read as `PairOwner::LegacyAddress` and serves any caller, as an unscoped pair
does, and `adopt_bridge_owner` rewrites it (or an unscoped one) to the bridge id the first time
that bridge accepts the key (`validate_hue_credentials`, which runs at boot and every 30 s while
idle). A 2xx to a request carrying the key is the proof: bridges issue their own keys. The DTLS
pair is resolved without comparing owners at all, because the readiness read and the activate PUT
that precede the handshake already went through a client bound to the owner. A pair written with
no bridge id in hand (the boot migration) clears the previous owner instead of inheriting it.

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

So the seven `effective_hue_app_key` call sites are **not** seven components each resolving
independently — they all go through that one cached handle, and an unpaired launch costs one
backend read, not seven. What an unpaired launch *does* produce is several identical
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
remains the legacy fallback. Resolving nothing yields `AUTH_INVALID_RE_PAIR_REQUIRED` (credential
validation: its own `HUE_CREDENTIAL_INVALID`) rather than a new status code — a new code would fall through every shipped `switch` into the default branch and
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

**The entertainment-area snapshot is cached process-wide, single-flight.** Several readers want the
same bridge payload through different paths — the health monitor's live-stream check and its area
check, the user's "Validate again", the launch restore's busy-area wait — and they can land within a
second of each other. `area_cache.rs` removes the duplication on this side of the IPC boundary: a
caller arriving mid-fetch waits on the slot and reuses the leader's result, a bridge-side mutation
bumps a generation counter so a fetch issued before it can never be served after, and every read
gating a mutation asks for `Force` to bypass the cache outright.

**The area-cache TTL is derived, not tuned — 1.5 s.** `HUE_AREA_CACHE_TTL_MS` in `area_cache.rs`.
It was sized against two frontend loops that co-fired within ~1.1 s of each other every few ticks;
any TTL at or above ~1.1 s caught all of it and a larger one caught nothing more. With one monitor
the co-firing is rarer, but the 3 s blocked-area cadence and a user's revalidate still meet it, and
1.5 s stays under that cadence, so a blocked area is never read off a snapshot older than the tick
before. Worst-case staleness is well under the 5 s live-stream check and the bridge's ~10 s
entertainment inactivity close. The value is purely observational: stream liveness is read from the
local `is_shutdown_signaled` probe and the reconnect monitor, never from this cache.

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

**One health monitor, in Rust, is the only thing that asks the bridge how it is.**
`commands/hue/health.rs` runs a single background task that owns bridge reachability, the stored
key's validity, the saved area's readiness (with the active streamer) and the stream's own state,
and publishes them as one `HueHealthSnapshot` with a revision — on `hue://health` to every window and
from `get_hue_health`. The frontend holds a copy in an external store
(`features/hue/state/hueHealthStore.ts`) and reads it through `useHueHealth(selector)`, so the status
chip, the Devices card and the notices re-render only on the slice they read. It replaced four
frontend loops (App's stream health and bridge probe, the Devices view's runtime status and area
readiness), a read cache and a restart bus. Those loops lived in different React trees, each with its
own cadence, visibility handling and give-up rules, and each asked the bridge on its own: two of them
could hit the same endpoint seconds apart, the dedupe had to be rebuilt twice (a frontend coalescer,
then `area_cache.rs`), and the runtime's state only reached a loop that happened to be awake. One
task sees the runtime directly, so it knows when a stream is live and when nothing needs asking.

What it reads, and when:

| Signal | Runs while | Cadence | Bridge call |
|---|---|---|---|
| Stream, local | Hue is live (Starting, Running, Reconnecting) | 1 s with a window visible, 5 s without | none — the runtime lock, the dead-sender probe, the pending-colour flush |
| Stream, readiness | Hue is live and a window is visible | 5 s | `GET …/entertainment_configuration` (area cache, `Ours`) |
| Bridge probe | configured, not live, a window visible, not given up | 30 s | `GET /clip/v2/resource/bridge` |
| Area readiness | configured, the Devices view mounted, a window visible, not fed by a live stream | 15 s; 3 s while another session holds the area; 15 → 30 → 60 → 120 s while the bridge does not answer | `GET …/entertainment_configuration` (area cache, `Ours` or `Foreign`) |

- **It idles when nothing needs it.** With no bridge, area and pairing saved (the `toHueStartConfig`
  rule, read in Rust through `hue_start_request`) nothing is scheduled. With no window visible and
  no live stream the task parks on a `Notify` and makes no call at all, however long the app sits in
  the tray; a live stream in the tray gets the 5 s local read only, which is what flushes a colour
  the tray queued while the stream was starting. The window says what it needs with
  `watch_hue_health({ visible, areaReadiness })` whenever its visibility changes — the old convention,
  moved from each loop into the one store. `visible` is `isWindowVisible` (the document and Rust's
  read of the native window, `ui-and-shell.md`), since WebView2 can report a window hidden in the
  tray as visible — and the Devices view adds `areaReadiness` while it is
  mounted. What wakes it: a window's watch, a start, stop or restart finishing (`WakeOnDrop` on
  those three commands and a wake in `set_active_stream`), a window saving one of the pairing keys
  (`lastHueBridge`, `lastHueAreaId`, `hueAppKey`, `hueClientKey`, `credentialStorageBackend`), and
  the manual retry. A snapshot is published only when its content moved.
- **A live stream is proof enough on its own**, so the credential probe stops while one runs and is
  re-armed the moment it ends, and a live stream on the watched area feeds the area slice from its
  own readiness check instead of a second read.
- **The 5 s live-stream check is load-bearing beyond the chip.** Its answer goes through
  `status_refresh_with_evidence`, which moves the runtime to `Reconnecting` on a transport fault,
  to `Failed` on a refused key, and counts a transient fault against the reconnect budget. Changing
  the cadence changes how fast a flaky bridge exhausts that budget; 5 s is the App chip cadence it
  replaced.
- **Hidden means nothing new.** The old loops paused while hidden too, so the idle tray costs what
  it cost before — nothing — and now also with the Devices view open behind it.
- **`get_hue_health` never calls the bridge.** It runs the local part of the runtime refresh first,
  so a caller that has just started or stopped the stream itself (the Devices card's Start and
  Start Again) reads the result rather than the state it changed away from. `get_hue_stream_status`
  stays registered for its tests; no window is granted it.

**Background bridge probing gives up; it never re-discovers on its own.** A bridge paired on another
Wi-Fi network used to be polled for the whole session with nothing on screen to say so. The probe
and the area check each keep a failure budget (`FailureBudget` in `health.rs`): **4 consecutive
failures *and* a 90 s unbroken streak**, after which that signal stops and the snapshot's
`bridge.gaveUp` puts a manual retry on the notice. `retry_hue_health` re-arms both and reads at once.
The loops they replace also started over whenever their effect re-ran, and those restarts are kept:
the probe on a pairing change and when a live stream ends, the area check when the Devices view
mounts again. A window merely showing again restarts neither.

Both terms are load-bearing. A count alone gives up after 12 s on the 3 s blocked cadence; a
duration alone gives up on the first failed tick of a slow one. Telling a user their bridge is gone
because the Wi-Fi hiccupped for ten seconds is worse than the over-polling being fixed, so any
success resets the streak — two failures, a success, then two more is not four failures. The area
check also backs off (15 → 30 → 60 → 120 s) while the bridge does not answer, so it gives up at
105 s rather than at the seventh 15 s tick.

Only a bridge that did not *answer* counts (`HUE_CREDENTIAL_CHECK_FAILED`,
`HUE_STREAM_READINESS_FAILED`). `HUE_CREDENTIAL_INVALID`, `HUE_BRIDGE_IDENTITY_MISMATCH` and
`HUE_STREAM_NOT_READY` are answers from a reachable bridge, with their own recovery paths (re-pair,
release the area) — counting them would put a "check again" button in front of a problem retrying
cannot fix. `gaveUp` survives the retry until the bridge answers: clearing it on the press made the
retry button delete itself the instant it was pressed.

There is deliberately **no network-change listener** and no slow background heartbeat: a window
coming back, a pairing change or the next launch re-arms the probe, which covers returning to the
right network later.

**Hue is not retried in the background — except once, at launch, for a busy area.** The rule is that
a Hue start the bridge refuses is settled on the spot (Off, or USB alone with a notice) and only the
user or the next launch tries again. The one exception is the launch restore's wait, in the
lighting transaction (`lighting_mode/outputs.rs`, `origin: "boot"`). After an
unclean exit the bridge keeps counting the dead process as the area's streamer for 10–20 s, so a
relaunch inside that window has its restore refused and used to land on Off for no reason the user
could see or fix. When the Hue start answered `CONFIG_NOT_READY_GATE_BLOCKED` at boot, Rust
probes the area's readiness every 3 s for up to 25 s and, the moment the area is free, acts once. What it does depends on how the restore ended:

- **Off (a Hue-only restore) — resume.** The restore runs again, once.
- **Running on USB with Hue left out (a `[usb, hue]` restore) — rejoin.** USB runs at once, as the
  A2 rule says, and Hue is added back to the session's selection: the transaction brings the stream
  up and re-applies the mode on both targets, which restarts the running worker — the same brief
  glitch the user's own add costs. It never writes `lastOutputTargets`: the drop was session-only,
  and the saved set still holds Hue.
- **Busy is decided by readiness, not by the start code.** The gate code also covers an unreachable
  bridge and an unusable area, and its `details` only name the missing prerequisite. Busy means
  the readiness reasons are exactly the `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` sentinel; any other
  answer (unreachable, re-pair, no channels, area gone) ends the wait at the first probe. An auth
  code from the start never qualifies at all. For a rejoin this is also why the left-out notice
  waits for that first probe: by the gate code alone a held area would read "can't reach the
  bridge". A busy answer raises the `busy` variant (Hue joins by itself), which stays up for the
  whole wait; any other answer raises the notice the restore would have raised.
- **Boot only.** The interactive paths never schedule either retry; an interactive `[usb, hue]`
  start the gate refuses keeps A2's notice and waits for the user.
- **The user always wins.** Any lighting-mode choice, any output-target change, or any Hue
  release cancels the wait — the resume keeps running through a target change that still includes
  Hue, the rejoin does not. A retune of the running mode is not a mode choice and cancels nothing.
  Unplugging the strip a rejoin was waiting beside ends the mode and cancels the rejoin with it,
  since there is no running mode left to add Hue to (`ui-and-shell.md`). A choice made after the
  wait already gave up takes the gave-up notice down as well; it used to outlive the choice
  whenever the wait ended first. The resume's notice says lighting
  will resume by itself and, if the window closes first, that it stayed off; the rejoin's says Hue
  will join, is cleared when it does, and turns into "stayed busy, running on USB only" if the
  window closes first.

**Lights return to their pre-stream state when Hue output ends.** Ending entertainment
(`action: stop`) makes the bridge put each light's colour back but leave it **on** — a lamp that was
off before Ambilight stayed on afterwards (seen on hardware, 2026-09-23). Hue Sync puts it back
off, and so do we now (`commands/hue/light_restore.rs`).

- **Snapshot point.** The start already GETs every area light (`/clip/v2/resource/light/{id}`) for
  its gamut right before the sender PUTs `action: start`; the same response now yields `on`,
  `dimming.brightness` and the colour. That is the last read before we touch the lights, so nothing
  streamed can be captured. The window is the few tens of ms until activation: a change another
  client makes to a light in that gap is lost and the older state comes back. A light already in
  `mode: streaming` is not snapshotted. The area's lights are the channel members resolved to light
  services, i.e. exactly the lights we drive.
- **One snapshot per logical session, keyed by bridge + area** (`HueRuntimeOwner::light_restore`).
  Reconnects never read it and never touch it (they use the metadata-only fetch), a restart or a
  later start of the same area keeps the first one — by then the lights show our stream or the
  bridge's "restored but on" state — and a `Failed` runtime keeps it for the next stop.
- **Which stops restore.** `stop_hue_stream` always does: every frontend caller ends Hue output (Off,
  Hue deselected, a mode without Hue, a start the mode apply left out, the test lease giving back a
  stream it opened, the Devices stop button, quit). A mode change that keeps Hue never stops the
  stream (`start_hue_stream` answers NOOP), and `stop_led_test_pattern` does not touch the Hue
  runtime. A start or restart onto *another* area restores the held one first, before reading the
  new area, so a light in both is snapshotted in its real state. A start that a stop overtook while
  its sender was being built restores too, because that stop found nothing to deactivate or restore.
- **Order.** The restore runs after the stop's deactivate and after the sender has signalled exit
  (it signals only after its own deactivate): during entertainment the bridge overrides light
  writes and then puts its own state back. If off lamps ever come back on with every restore PUT
  logged as successful, the bridge's own post-stream restore is landing after ours and needs a
  settle delay — that has not been seen, and none is added.
- **A start waits for a stop's restore.** `stop_with_timeout` leaves the runtime `Idle` at once,
  and the deactivate, the sender wait and the restore all run after it, so a start issued in that
  window (another webview, the test lease, a tray action) used to read the lights while the restore
  was still walking through them: the ones it had not reached yet were snapshotted "on", and that
  session's own stop switched them back on. `stop_hue_stream` now holds
  `HueRuntimeStateStore::stop_in_flight` from its first lock until the restore returns, and
  `start_hue_stream` / `restart_hue_stream` wait for it before they read the bridge. They only
  wait — nothing is held across a start, so a stop can still overtake a start as described above.
  The quit path does not take it: nothing starts after it.
- **The sender exits only when every handle is gone.** Both senders (DTLS and HTTP fallback) leave
  their loop once the frame mailbox closes, which happens when the last `HueColorSender` clone
  drops, and the stop drops only the runtime's handles. An ambilight worker driving Hue holds
  another one, and it used to take it once, at start (a `HueActiveOutputContext` snapshot), so a
  stop under a worker that still drove Hue waited out `HUE_STOP_TIMEOUT_SECS`, reported
  `HUE_STOP_TIMEOUT_PARTIAL`, and restored with the sender still running — the fallback's next
  light PUT undid the restore. The worker now follows the runtime's live output slot instead (next
  entry), and lets go of the handle within a frame of the stop. What follows is the ordering that
  made the stop safe before the slot existed; the lighting transaction keeps it
  (`lighting-transaction.md`), and the next entry says which parts the slot now guarantees on its own. `apply_mode_change` hands the worker the
  Hue slot only when `targets` names Hue, and removing
  Hue from `[usb, hue]` re-applies the mode on `[usb]` and awaits it before the stop
  (`ui-and-shell.md`). Off awaits `stop_lighting` before `stop_hue_stream` whenever a mode is
  running, whatever its targets. It used to call `stop_lighting` only when `usb` was an active
  target, so Off from a Hue-only mode sent `stop_hue_stream` alone: the worker kept capturing the
  screen and holding its handle, the stop timed out partial, and on the fallback the worker went on
  driving the lights after the restore, with nothing left to stop it. Off from `[usb, hue]` ran
  the two stops side by side, which held only because the worker's join landed inside the stop's
  wait; it is sequential now as well. The quit path already had this order (`[shutdown]` step 1
  stops the worker, step 2 stops Hue). The Devices card's Stop retrying and Retry stop go through
  the same removal (`release_hue_output`, `lighting-transaction.md`); they used to call
  `stop_hue_stream` directly. A Retry stop comes after a partial stop, so the runtime already reads `Idle` and the
  health poll has dropped `hue` from the active set, but a worker whose mode still names Hue keeps
  its handle: that, not the active set, decides whether the mode has to let go first. The retry
  itself is unchanged — a second `stop_hue_stream`, which finds no stream to deactivate and no
  snapshot left to restore.
- **The worker follows the live stream, not the one it started with.** `HueRuntimeOwner` owns a
  `HueOutputLive` slot: the active stream's channels and sender plus a generation counter, written
  in `set_active_stream` together with `active_stream`, which is the only production writer of
  that field. A start, a reconnect and a restart publish the new stream and bump the generation;
  a stop, a reconnect's teardown and a start the gate refuses publish `None`. The worker keeps a
  copy and checks the generation once per frame, one relaxed atomic load with no lock and no
  allocation while nothing moved (the same shape as `RoomGeometryLive`). When it moved, the worker
  drops its old handle first, then takes the new context and rebuilds its Hue sample table; on
  `None` it stops sampling Hue and keeps driving USB or WLED. It keeps no other clone of the
  sender. Before this, a reconnect replaced the stream while the worker went on writing to the
  sender it was handed at start: the status read Running and the lamps froze.
  - **Guaranteed by Rust now.** A stop under a worker whose targets name Hue sees the sender exit
    instead of timing out partial, because the worker releases its handle at its next frame; the
    sender still signals only after its own last write, so the restore still comes after every
    frame the worker sent. After a reconnect or restart the worker drives the new sender. A worker
    whose targets leave Hue out is never handed the slot, so it never samples or sends Hue.
  - **Owned by the Rust transaction, not yet by its callers.** The lighting transaction
    (`lighting_mode/outputs.rs`, [`lighting-transaction.md`](lighting-transaction.md)) runs every
    ordering above itself: Hue up before the worker, the worker let go before the stream stops, Off
    stopping the worker first whatever its targets, a stream no running mode feeds given back, and
    a test lease leaving an adopted stream to its mode. Until the frontend's callers move to it,
    the orderings above are still how the frontend drives the old commands. Off still has to call
    `stop_lighting` there: Rust does not end a mode because its Hue output ended, so a Hue-only
    worker would go on capturing the screen with nothing to send.
- **The sender streams the newest frame, never an older one.** The worker hands frames to the
  sender through a newest-wins mailbox (`HueFrameMailbox` in `frame.rs`): a put replaces a frame
  the sender has not taken yet. It replaced a two-slot `sync_channel`, whose `try_send` dropped the
  *newest* frame when full. The DTLS loop (`DtlsSendLoop`) waits for a frame, sleeps out the rest of
  the 50 ms floor, and only then takes the newest frame on hand. It used to take the frame first
  and send it after the sleep, 50–67 ms stale. The floor and the 2 s keep-alive are unchanged; the
  HTTP fallback loop already took the newest frame when a request slot came up.
- **The sender eases between targets.** A packet carries a step from what the lamps were last sent
  towards the newest target, not the target itself (`HueEasing` in `commands/hue/easing.rs`). With
  a newest-wins mailbox and no easing the lamps received a jump every 50 ms, and an irregular one:
  the worker's frames and the sender's ticks run on different clocks, so a tick finds one new target,
  none, or two, and the size of each jump followed that beat. That judder is what read as colours
  "stepping" next to Hue Sync. The step is `1 − exp(−dt/τ)` of the remaining gap with `τ` one
  tick (the 50 ms floor), `dt` the time since the previous packet capped at two ticks: about 63 % of
  the gap per packet, so a cut still lands in two or three packets and the easing costs roughly one
  tick of lag. While still gliding the loop wakes for the next tick with no new frame; once arrived
  it goes back to waiting on the mailbox and the 2 s keep-alive. Newest-wins is kept: a target
  replaced before a tick is never eased towards. The first target of a session, the Solid colour
  path and test patterns (`HueMotion::Snap`) are shown as they are. Easing runs in wire space —
  after the pipeline's gamma stage, before brightness — which is linear light, so a halfway packet
  is the physical mix of the two colours rather than a gamma-encoded average that dips dark. The
  gamut clip runs once per target on arrival, not per packet: a blend of two in-gamut colours stays
  in gamut. Colours reach the sender as `f32` on the 16-bit wire scale; they used to be `u8` after
  the gamma stage, which leaves a dark scene only a few levels to step through. The 50 ms floor is
  untouched — easing changes what a packet carries, never how often one goes out. The HTTP fallback
  does not ease: at its ~10 requests a second per light, a glide would only spend the budget.
- **Colour mode.** CLIP v2 reports `color.xy` in both modes, so the mode is read from
  `color_temperature.mirek_valid` (`mirek` is null outside the ct spectrum). An on light gets one PUT
  with `on`, `dimming.brightness` and either `color_temperature.mirek` or `color.xy`, never both. An
  off light gets `{"on":{"on":false}}` alone: v1 refused colour writes to an off light, and the
  bridge has already put its colour back. The HTTP fallback sender has no entertainment session to
  end, so an off light it drove keeps the last streamed colour for its next switch-on.
- **Pacing and bounds.** One PUT per light through the fallback's `RequestPacer` at the ~10 req/s
  light budget, so ten lights take about a second. An interactive stop gives the restore
  `HUE_LIGHT_RESTORE_BUDGET` (2.5 s); `stop_hue_stream` is `async` for this, because a sync command
  runs on the main thread and froze the window. A refused key (the classifier's `AuthInvalid`,
  #418's HTML page included) or an unanswered request ends the restore; a throttle is retried once;
  a light rejected on its merits is skipped. None of it changes the stop's status: logged, never
  fatal, and a snapshot that could not be written is dropped, not retried.
- **Quit.** `[shutdown]` step 2 calls `stop_hue_stream_before_exit` with a deadline 3.3 s after
  cleanup starts; the deactivate PUT, the sender wait and every restore request honour it, so a
  slow bridge ends the step at that deadline rather than at the 4 s watchdog, and the thread is
  abandoned 100 ms after it regardless. A slow step 1 leaves step 2 about 1.8 s.
- **Unclean exit cannot restore.** A crash or kill never reaches the stop; the bridge times the
  session out and the lights stay on in their restored colour. Accepted — nothing on disk carries the
  snapshot to the next launch, and a snapshot taken then would read the lights already on.

## Gotchas

- **Hue `+y` is the TV wall, and it is drawn at the *top* of the room-map canvas.** `x` is left/right, `y` is depth with `+1` at the screen and `-1` behind the viewer, `z` is height. Three comments in `HueChannelOverlay.tsx` used to say `+y` was the canvas *bottom*; the code never agreed with them — `hueToMetres(-worldY, …)` maps `+1` to `0 px`. No first-party Signify statement is quotable here: the Entertainment reference is behind a developer-portal login and OpenHue types the field with no description, so the axis is established from two independent implementations — diyHue synthesises the TV-mounted gradient strip at a constant `y = 0.8`, and HyperHDR treats `y >= 0.75` at TV height as the screen's own edge. Note also that without a TV anchor the runtime collapses this depth axis onto screen *vertical*: `+y` samples the top of the screen, `-y` the bottom. With one, height (`z`) picks the vertical band instead and depth only feeds the ambience blend — see `room-map.md`. Anything naming that axis must therefore name it for the room (far/near), not for the screen.
- **`get_hue_area_channels` does not always answer with the bridge's own numbers.** It has a fast path (`channels_to_info_via_owner`) that serves the running stream's channel list instead of fetching, and that list is the one `apply_channel_placements` overwrote with the user's local placements before `store_active_stream_context` stored it. The persistent sender does the same for a solid-colour session. So **while lighting is on, the "bridge positions" it returns are ours**, and any code comparing local placement against them compares our numbers with themselves — reporting "in sync" most confidently at exactly the moment a user is looking. So a read counts as the bridge's only when the runtime was `Idle` on both sides of it: `useHueAreaChannels` asks `get_hue_health` — a local runtime read, no bridge call — before and after the fetch and exposes the answer as `channelsFromBridge`, and a failed status read counts as not idle. (The snapshot the Devices view holds may lag an event behind, so the hook asks fresh on both sides of the fetch rather than trusting it.) A trusted read is what the channel map's "does the bridge have this arrangement" verdict compares against, and it is persisted as `ShellState.hueBridgeSyncedPositions` (per area) — the bridge's arrangement as last known — which the verdict falls back to while lighting is on. Comparing against a snapshot of the last push instead meant the verdict never noticed a layout changed in the Hue app. The list is re-read when the runtime returns to `Idle`, on "Revalidate", after every save, and before every pull: "Take bridge's" adopts only a fresh read that is the bridge's own and refuses otherwise, since the same fact that rules out the verdict rules out adopting a list fetched mid-stream — it would pull our own placements back and look like it worked. The pull takes the bridge's height too, stamped `zOrigin: "bridge"` (a zone-bound channel's `zoneRelativePosition` is re-derived through its zone, clamping where the zone cannot reach the bridge's position, and the panel names those channels); a channel the bridge reports no height for keeps its own. The snapshot it records is the bridge's read, so a pull always settles the verdict unless a zone clamped. A save records what it sent for the channels the bridge took and the bridge's previous position for the ones it skipped — the skipped ids exist only in the English prose of `details` (`skipped_details`), which `hueWritebackResult.ts` parses — and the re-read that follows corrects the record either way. The bridge quantises what it stores slightly; the verdict's 0.005 tolerance assumes that stays below it.

- **A channel's position is written through `locations`, never through `channels`.** A PUT carrying `channels` is refused with HTTP 400 (`Property [channels] cannot be specified for this request type`) — checked on a real bridge on 2026-09-23 — so until then "Save to bridge" had never saved anything. The official CLIP reference describes a channel's `position` as *the average position of its members*: it is derived, and the writable source is `locations.service_locations[].positions`, one entry per entertainment service. `update_hue_channel_positions` therefore GETs the area, replaces positions inside the full list, and PUTs the whole list back (the bridge answers 200 and re-derives the channel, quantising the value slightly). The mapping is taken only when it is unambiguous: the channel has exactly one member, that member is segment `index` 0, no other channel references the same service, and the service has exactly one position. Anything else — a gradient strip (two positions spread over several segment channels, which the bridge interpolates), a channel grouping several services — is skipped and reported, never approximated; the lights beside it still save. A height of unknown origin (`zOrigin` absent) keeps the bridge's own `z` rather than writing the seeding placeholder. A 2xx whose `errors[]` is non-empty counts as a rejection, and a Hue-shaped 401/403 on either request is the usual re-pair signal. A 404 is the area itself gone (deleted in the Hue app, or an id from another bridge) and answers `CHAN_WB_AREA_NOT_FOUND`, not a network error. The command is `async` and runs its keychain read and two blocking HTTP calls on the blocking pool: as a sync command Tauri ran it on the main thread, and the window froze for up to ~10 s against a slow bridge.

- **Placement is authored in one place, and it is the room map.** The Devices page carried a drag pad, then five coarse presets; both are gone. It lists what the bridge reports — the channel's own id, its bulb count, its zone — and owns the bridge sync, because that is bridge-side. Two writers for one value is what the earlier surfaces were, and the smaller of the two could not express distance and height in metres, which is what placement is for. The room map fetches the channel list itself (`useRoomMapHueChannels`) rather than waiting for the Devices page to have been opened; seeding is shared between both surfaces through `room-map/model/hueChannelSeeding.ts` so they cannot disagree about which channel is which.

- **`hueCredentialEvents.ts` exists because pairing is invisible to everything outside `useHueOnboardingCore`.** App owns the `hueStartConfig` mirror — the projection the reachability probe and the USB reconciler both read — and until this bus it was written on boot and on a lighting-mode change and nowhere else. So pairing a bridge, or picking an area, left every one of those consumers on `null` until the user happened to switch modes. Subscribers deliberately re-read `shellStore` rather than trusting a payload: no single emit site holds the whole projection (pairing knows the bridge and credentials but not the area; area selection knows the reverse), and a diff assembled from partial knowledge is how the mirror drifts. Emit *after* the write resolves, never beside it — firing early hands the subscriber the value the write is replacing. Third bus of this shape, after `connectionEvents.ts` and `firmwareProfileEvents.ts`; when a fourth is needed, the shared-instance question in `device-output.md` is the one to reopen instead.
- **A rejected runtime-status read is not a runtime state.** The health commands never answer with an error, so an `invoke` that rejects means the read itself failed — it says nothing about whether the stream is up. `useHueRuntimeStatus` once minted a `Failed` status for it, which conflated the two: the bridge card, finding no Running/Reconnecting, fell through to Ready, and the Devices-tab loop of the time, which polled only in Starting/Running/Reconnecting, went silent — one IPC blip mid-stream left the card on Ready. The health store keeps the last snapshot Rust published and holds the rejection beside it (`readFailure`, surfaced as `runtimeStatusReadFailure`, code `HUE_STREAM_STATUS_UNAVAILABLE`). While it is set, `deriveHueBridgeCardState` ignores the stale status for the runtime-derived states and shows `statusUnknown` where it would have said Ready, and the store re-asks, backing off 2 → 4 → 8 → 16 → 30 s (`runtimeStatusRetryDelayMs`) until a read lands; an event from Rust clears it too. A backend-reported `Failed` is a real answer and keeps its own mapping (next entry). This is not under the bridge give-up budget above: it is a local IPC read, and giving up would bring back the stuck card.
- **A backend-reported `Failed` is a stopped stream, not a Ready bridge.** The runtime enters `Failed` with three codes: `TRANSIENT_RETRY_EXHAUSTED` (the reconnect budget ran out, `retry.rs`), `HUE_STREAM_START_ABORTED` (the start unwound before a stream context existed, `StartAbortGuard` in `reconnect.rs`) and `AUTH_INVALID_CREDENTIALS` (the bridge refused the key at start or mid-stream). It stays there until the next start or stop, and `deriveHueBridgeCardState` used to have no branch for it: the card fell through to Ready, and `TRANSIENT_RETRY_EXHAUSTED`, matching the `TRANSIENT_` prefix, to a reconnect that was no longer happening. It now maps to `streamFailed` — FAILED pill, the code's own text via `hueStreamFailureReasonKey` (a generic "stream stopped" line for any code without one), and Start Again, which calls `restart_hue_stream` because that re-reads readiness itself, so a stale check on the card cannot block the way back. Re-pair is added only when the status carries the repair hint; the runtime auth failure does not flip `credentialState`, and routing it to `authError` would keep asking for a re-pair after one had succeeded, since the runtime stays `Failed` until the next start. An unreachable bridge, a refused credential, a pairing run and a missing area keep their own cards ahead of it, and `statusUnknown` stays separate: a rejected read over a held `Failed` shows as unknown. The status bar (FAILED, red, deep-link to Devices) and the Lights Hue row ("stream stopped", red dot) read the same state from `useHueStreamHealth`, which only reports it while Hue is a selected output. A held `Failed` cannot outlive the start or stop that ended it: the health monitor publishes the runtime's new state as that command returns, where it used to wait out a 15 s dead-stream poll or an invalidation bus.
- **Hue availability is read from the live stream, so a test pattern started with the mode off sees no bridge.** `start_led_test_pattern` asks `snapshot_hue_output_context`, which answers only while `active_stream` is `Some`. USB and WLED are read from the connection and the sink registry, which survive a mode change — so the same run reports a disconnected strip as available and a paired, reachable bridge as absent, and degrades to preview-only. The test lease does exactly that, in Rust: LED Setup's test and the popup's pattern tiles send `apply_outputs` with `origin: "leaseHue"` (`acquireHueForTest` / `releaseHueAfterTest` in `modeApi.ts`), and the transaction brings a stream up for the run from the saved bridge, area and pairing (`commands/hue/hue_config.rs`) and stops it afterwards ([`lighting-transaction.md`](lighting-transaction.md)). It must stop *only* what it opened — a stream that was already up belongs to a live mode or another surface, and releasing that switches off lights the test never turned on. It lives in Rust rather than in a window because LED Setup and the control popup are separate webviews with no shared React tree. What it opened can change hands: a mode started during the run (tray, shortcut, the popup's mode strip) finds the stream up and its worker drives it. So the release reads what runs first and leaves the stream to a running mode whose targets name Hue; a stop there would end that mode's Hue output (see "The worker follows the live stream").
- **The LED control popup's auto-start never reaches Hue.** Revealing the popup (tray, LED Setup's Test & Preview) starts a pattern with no gesture from the user, and it used to send it to `lastOutputTargets` — so a Hue-only setup with no strip lit the lamps the moment the window opened. The auto-start now sends `targets: ["usb"]` explicitly (the "usb" channel is serial or WLED): the lease sees no Hue and opens no stream, and with no strip the backend answers `PATTERN_PREVIEW_ONLY` and the pattern stays in the twin. Colour, brightness and speed changes retune the run in progress with that run's targets, so dragging a colour cannot widen a strip-only test onto Hue. Picking a pattern tile is the explicit gesture and still uses the saved targets, Hue included; the popup has no target selector. While a saved Hue target is left out, the popup says so and points at the tiles, instead of the generic preview-only text, which claims no device is connected. LED Setup's own Run test button is a gesture too and keeps the saved targets.
- **A bridge allows one active entertainment streamer at a time.** `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` in the log means something else holds the session — often a previous instance of this app that did not shut down cleanly, or the official Hue Sync app. It is not a pairing failure and must not be reported as one.
- **Our own running stream is not a foreign streamer, and only our own running stream is exempt.** The bridge names the holder only by an `auth_v1` id, and learning ours costs a `GET /auth/v1`, so ownership is read from this process's runtime instead (`streams_area`): state `Running`, an active stream for the same bridge and area, and a sender that has not exited. Only then does readiness (`ActiveStreamerView::Ours`) drop the sentinel — for `get_hue_stream_status`'s health poll and for `check_hue_stream_readiness` from the frontend, which used to report our own area as held by another app and log it every ~5 s. Every gate about to start a session — start, restart, reconnect — passes `Foreign`. A session a previous run left on the bridge holds the area under the *same* key and must keep reading as busy: nobody has shown the bridge accepts a fresh start over it, and the boot retry waits on exactly that sentinel.
- **A gate-blocked start says why in `details`, as tokens.** `start_with_evidence` appends `"; readiness: <readiness code>[, HUE_STREAM_NOT_READY_ACTIVE_STREAMER]"` to `CONFIG_NOT_READY_GATE_BLOCKED`'s details, so the frontend can tell a busy area (the sentinel) from an unreachable bridge (`HUE_STREAM_READINESS_FAILED`) without a new code. A refused key never reaches that branch — it is `AUTH_INVALID_CREDENTIALS` with the `repair` hint.
- **`entertainment_configuration` deactivation can race between three call sites:** the sender thread's own cleanup, the foreground `stop_hue_stream` command, and the reconnect monitor's pre-restart cleanup. Uncoordinated, all three PUT `{"action":"stop"}` to the same area, which the bridge logs as duplicate stale-state mutations and which historically produced the "phantom active streamer" symptom (bug audit A1.3). `DeactivateToken` is the coordination primitive — whichever caller wins `try_acquire()` performs the PUT, every later caller sees the in-flight bit and no-ops. It gates one PUT *in flight*, not one PUT per lifetime: a PUT that fails hands the token back, because what it dedupes is concurrency, and a token burned on a failure means no later caller ever retries and the bridge keeps `active_streamer` until it is restarted. A PUT that succeeds keeps it burned — releasing there would reopen the race. That rule lives in `settle_deactivate`, separately from the HTTP call, so it is testable without a bridge; the log has to live there too, because four of the six call sites discard the `Result`.
- **`DTLS entertainment stream established` is the line that proves streaming actually started.** Pairing succeeding says nothing about the stream.
- **Bug H2 — gamut clipping used to discard luminance, not just chroma.** The fix converts RGB to CIE xy plus the input's own luminance (`big_y`), clips the xy point to the bulb's gamut triangle, then converts back using that *same* luminance rather than a hard-coded 1.0. Before the fix, the inverse transform renormalised so the largest channel saturated — preserving hue but discarding brightness, which the frame builder then tried to claw back through the brightness scalar, producing visibly dim saturated content and, on gamut-edge projections, momentary all-zero RGB that drove the ambilight-frame stutter.
- **Discovery touches the cloud; the manual-IP path does not.** `discover_hue_bridges` queries `discovery.meethue.com` beside LAN-only mDNS; that endpoint is one of the app's three outbound calls (see the README), and the manual-IP path exists precisely so a user can avoid it.
- **A failed read-back rolls back BOTH keychain halves, never just the bad one.** `migrate_hue_credentials_to_keychain` writes, reads back, compares, and only then reports success; on any mismatch it deletes both entries. Deleting only the mismatched half looks tidier and is wrong — `resolve_hue_credentials` prefers a complete keychain pair over the request fallback, so a stale pair left behind shadows the working plaintext credentials and yields a broken bridge that reports a keychain success. Rolling both back degrades to the plaintext path, which works. The order is fixed: write, read back, *then* clear plaintext. Never clear on a write acknowledgement alone.
- **Only the literal `"keychain"` licenses deleting the plaintext copy.** An absent `credentialStorageBackend` — every pairing failure path, and any Rust build predating the migration — means there is no evidence the keychain holds anything, and the only safe response to no evidence is to keep the copy. `CredentialBackend::as_str` can also emit `"noop"`, which is outside the TS union. Test for the one permitting value; never switch exhaustively over the union.
- **"Paired" is `hueAppKey || credentialStorageBackend === "keychain"`, never the app key alone.** The same trap caught the client key one release earlier: a condition that reads a *present secret on disk* as proof of pairing silently reports "unpaired" the moment that secret legitimately moves to the keychain. Both `toHueStartConfig` and the `useHueOnboardingCore` boot restore carry the two-armed predicate; getting it wrong there kills Hue at boot and on every seamless target switch with no status code and no toast, because both call sites read `null` as "no bridge configured" and skip. The empty username and client key they pass downstream are exactly what make Rust resolve from the keychain.
- **Credential cleanup is not a store migration.** `migrateShellState` is a pure function with no Tauri access, so it can never prove the keychain holds a copy before deleting the plaintext one — on a machine with a locked or unavailable keychain that would destroy the pairing. The one-shot cleanup for old installs is a Tauri command called at boot instead, and it clears nothing unless the response comes back `keychain`.
- **A Hue command's `Result` is structural, not a throwing surface.** Every command in `commands/hue/commands.rs` returns `Ok` on every path; coded failures ride the status object. The `Result` cannot simply be narrowed away either — Tauri fails an `async` command that takes a reference (`State<'_, _>`) and does not return one, with an `AsyncCommandMustReturnResult` trait-bound error. `get_hue_area_channels` is the shape to copy: `{ status, channels }`, `channels` empty on every failure arm, and `HUE_AREA_CHANNELS_EMPTY` kept distinct from `HUE_AREA_CHANNELS_FAILED` so an area with no lights never reads as an unreachable bridge.
