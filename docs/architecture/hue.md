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
Linux Secret Service, via `commands/hue/credential_store.rs`. `shell-state.json` never holds a PSK.

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
