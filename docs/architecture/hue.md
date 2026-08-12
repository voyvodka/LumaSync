# Philips Hue

Everything about driving a Hue bridge that the code cannot tell you itself. Several of these are
protocol limits rather than preferences — changing them breaks the stream rather than tuning it.

Implementation lives in `src-tauri/src/commands/hue/`, the contract in
`src/shared/contracts/hue.ts`. **Hue has no feature module** — its UI is in
`settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx`.

## Decisions

**The streaming interval floor is 50 ms (20 Hz).** `HUE_SENDER_MIN_INTERVAL_MS` in
`commands/hue/sender.rs`. Going faster does not give a faster response — the bridge throttles and
drops the stream. Treat it as a protocol constant.

**Transport is HTTPS-first with an HTTP fallback.** Bridge Pro serves its local API over HTTPS
only, so pairing, IP verification, and credential validation must try HTTPS before falling back
for older bridges. A plain-HTTP-only client silently fails to reach a Bridge Pro and the failure
surfaces as a generic pairing error on a bridge that discovery found without trouble.

**Only an HTTP 403 means the credential is dead.** Any other failure is a transport problem.
Re-pairing on a timeout or a 5xx destroys a working pairing and forces the user back to the link
button for no reason.

**Credentials live in the OS keychain, not in the state file.** macOS Keychain, Windows CredMan,
Linux Secret Service, via `commands/hue/credential_store.rs`. `shell-state.json` no longer holds the
DTLS pre-shared key.

**The application key is still written to disk, and the asymmetry is deliberate.**
`resolve_hue_credentials` is the only function that reads the keychain, and it has exactly one
caller: the DTLS sender build in `commands/hue/sender.rs`. Every other bridge call —
`validate_hue_credentials`, `list_hue_entertainment_areas`, `check_hue_stream_readiness`,
`get_hue_area_channels`, and `start_hue_stream`'s internal readiness check — takes the application
key as an argument from the frontend and never consults the keychain. So the pre-shared key can be
dropped from disk today, because an empty client key in the start request makes the sender fall
through to the keychain; dropping the application key would instead send an empty
`hue-application-key` header, draw a 403, and let the shared classifier promote it to
`AUTH_INVALID_RE_PAIR_REQUIRED` — the user is told to re-pair, and nothing anywhere can read the key
back. **Do not clear `hueAppKey` until those five call sites resolve it keychain-first when the
request value is empty.** This looks like an unfinished job and is not one.

**Colour is clipped per-bulb to its gamut.** Hue bulbs come in gamuts A, B, and C, and a colour
outside a given bulb's triangle is not merely inaccurate — the bridge clamps it somewhere
unpredictable. Clip on our side so the result is deterministic.

**Zones are Hue-only.** The v1.5 W4-F unification collapsed a generic `Zone` discriminated by
`zoneType` back to `HueZone` alone. "Logical zone" was dropped because nothing in the field models
a name plus a channel-index list as a free-standing object — everyone models screen rectangles,
spatial 3D positions, or sink-internal addressing — and it confused users across two rounds of
testing. `ScreenZone` and `LedZone` will land later as separately prefixed types sharing no
discriminator with `HueZone`; a bare `Zone` is ambiguous across three industry namespaces.

## Gotchas

- **`commands/hue_stream_lifecycle.rs` is a re-export shim.** The implementation moved under `commands::hue::*`. Import paths still resolve through it; do not add new code there.
- **A bridge allows one active entertainment streamer at a time.** `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` in the log means something else holds the session — often a previous instance of this app that did not shut down cleanly, or the official Hue Sync app. It is not a pairing failure and must not be reported as one.
- **`DTLS entertainment stream established` is the line that proves streaming actually started.** Pairing succeeding says nothing about the stream.
- **Discovery touches the cloud; the manual-IP path does not.** The mDNS/discovery endpoint is the only outbound call in the entire application, and it has a manual fallback precisely so a user can avoid it.
- **A failed read-back rolls back BOTH keychain halves, never just the bad one.** `migrate_hue_credentials_to_keychain` writes, reads back, compares, and only then reports success; on any mismatch it deletes both entries. Deleting only the mismatched half looks tidier and is wrong — `resolve_hue_credentials` prefers a complete keychain pair over the request fallback, so a stale pair left behind shadows the working plaintext credentials and yields a broken bridge that reports a keychain success. Rolling both back degrades to the plaintext path, which works. The order is fixed: write, read back, *then* clear plaintext. Never clear on a write acknowledgement alone.
- **Only the literal `"keychain"` licenses deleting the plaintext copy.** An absent `credentialStorageBackend` — every pairing failure path, and any Rust build predating the migration — means there is no evidence the keychain holds anything, and the only safe response to no evidence is to keep the copy. `CredentialBackend::as_str` can also emit `"noop"`, which is outside the TS union. Test for the one permitting value; never switch exhaustively over the union.
- **The boot restore keys on the application key alone.** Requiring both keys was right only while both were on disk. Once the PSK moved to the keychain, that condition made every launch after the first restore no credentials at all and drop the bridge card to `NEEDS_REPAIR`. The empty client key it passes downstream is exactly what makes the sender resolve the pair from the keychain.
- **Credential cleanup is not a store migration.** `migrateShellState` is a pure function with no Tauri access, so it can never prove the keychain holds a copy before deleting the plaintext one — on a machine with a locked or unavailable keychain that would destroy the pairing. The one-shot cleanup for old installs is a Tauri command called at boot instead, and it clears nothing unless the response comes back `keychain`.
