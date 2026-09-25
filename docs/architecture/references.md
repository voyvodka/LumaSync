# External references

The specs and outside projects LumaSync actually leans on, one line each on what for. It is an
index, not a reading list: an entry earns its place by being something a change in this repository
has to be checked against. Versions are deliberately absent — `src-tauri/Cargo.toml` and
`package.json` are the truth, and a version quoted here would only drift.

**Reference, never source.** Most of the projects below are GPL-2/3 or EUPL-1.2; LumaSync is MIT.
A protocol shape is fair to implement; code is never copied, ported, transcribed or translated —
see [`serial-protocol.md`](serial-protocol.md) for the same rule applied to firmware.

## Philips Hue

| Reference | Used for |
|---|---|
| [OpenHue OpenAPI spec](https://github.com/openhue/openhue-api) ([bundled YAML](https://api.redocly.com/registry/bundle/openhue/openhue/v2/openapi.yaml?branch=main)) | Machine-readable CLIP v2 — endpoint paths, payload and response shapes, without a developer login |
| [Hue Entertainment API](https://developers.meethue.com/develop/hue-entertainment/) (developer account required) | HueStream frame layout, DTLS PSK handshake, streaming rate and keep-alive rules |
| [Hue developer — Get started](https://developers.meethue.com/develop/get-started-2/) | The on-bridge CLIP debugger at `https://<bridge-ip>/debug/clip.html` — HTTPS, as Bridge Pro requires |
| [Hue colour conversion](https://developers.meethue.com/develop/application-design-guidance/color-conversion-formulas-rgb-to-xy-and-back/) (developer account required) | RGB ↔ xy and the gamut A/B/C triangles behind the per-bulb clip in [`hue.md`](hue.md) |
| [RFC 6347 — DTLS 1.2](https://www.rfc-editor.org/rfc/rfc6347) | The transport under entertainment streaming; what the OpenSSL DTLS session implements |
| [`aiohue`](https://github.com/home-assistant-libs/aiohue) | Comparison point for CLIP v2 error handling, including how a 403 is classified |

## LED output

| Reference | Used for |
|---|---|
| [Hyperion.NG Adalight sketch](https://github.com/hyperion-project/hyperion.ng/blob/master/assets/firmware/arduino/adalight/adalight.ino) | The real `Ada` header, big-endian count and checksum the opt-in Adalight profile must match |
| [WLED DDP](https://kno.wled.ge/interfaces/ddp/) · [DDP spec](http://www.3waylabs.com/ddp/) (HTTP only — the HTTPS host does not answer) | The default WLED transport (`wled_sink.rs`) |
| [WLED UDP realtime](https://kno.wled.ge/interfaces/udp-realtime/) | DRGB, and DNRGB once a frame outgrows one packet — the non-DDP option. WARLS is not used |
| [WLED JSON API](https://kno.wled.ge/interfaces/json-api/) | `/json/info` for identify, LED count and `live` read-back; `/json/state` for power-off |
| [Adafruit NeoPixel best practices](https://learn.adafruit.com/adafruit-neopixel-uberguide/best-practices) · [powering](https://learn.adafruit.com/adafruit-neopixel-uberguide/powering-neopixels) | Power injection, level shifting and signal integrity — the hardware side of a strip that flickers |

## Reference projects

| Project | Licence | Used for |
|---|---|---|
| [Hyperion.NG](https://github.com/hyperion-project/hyperion.ng) | MIT | LED layout model, device drivers, and how screen regions map to lights |
| [WLED](https://github.com/wled/WLED) | EUPL-1.2 | The device on the other end of the WLED sink — protocol behaviour, never code |
| [Prismatik](https://github.com/psieg/Lightpack) | GPL-3 | Capture-to-colour mapping, read for comparison |
| [Firefly Luciferin](https://github.com/sblantipodi/firefly_luciferin) | GPL-3 | Capture loop and colour mapping, read for comparison |

## Platform and runtime

| Reference | Used for |
|---|---|
| [Tauri 2](https://v2.tauri.app/) · [plugins](https://v2.tauri.app/plugin/) · [capabilities](https://v2.tauri.app/security/capabilities/) | Command model, bundling, and the per-window permission model in [`ui-and-shell.md`](ui-and-shell.md#capabilities) |
| [`serialport`](https://docs.rs/serialport/) | USB serial enumeration and I/O |
| [`screencapturekit`](https://docs.rs/screencapturekit/) · [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) | macOS capture — stream config, pixel formats, GPU downscale |
| [`CGDirectDisplayID`](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid) | Multi-monitor identity behind `display_id` on macOS |
| [`windows-capture`](https://docs.rs/windows-capture/) · [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) | Windows capture |
| [`xcap`](https://docs.rs/xcap/) | Linux X11 capture |
| [`NSWindow.CollectionBehavior`](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct) | No native fullscreen on the main window; overlays join all Spaces as fullscreen auxiliaries |
| [`keyring`](https://docs.rs/keyring/) | OS keychain for Hue credentials. Since v4 the Apple store is a non-default feature, enabled explicitly |
| [`mdns-sd`](https://docs.rs/mdns-sd/) | Hue bridge discovery on the LAN. Hue only — WLED is reached by IP |

## Release and supply chain

| Reference | Used for |
|---|---|
| [minisign](https://jedisct1.github.io/minisign/) | Updater signatures; the public key is embedded in `tauri.conf.json` |
| [`tauri-action`](https://github.com/tauri-apps/tauri-action) | The release build. Pinned to a commit SHA because it handles the signing key |
| [GitHub branch protection API](https://docs.github.com/en/rest/branches/branch-protection) | Checking required status contexts against the job names CI really emits |
| [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) · [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) | Commit messages and `CHANGELOG.md` format |

## i18n and accessibility

| Reference | Used for |
|---|---|
| [i18next](https://www.i18next.com/) · [react-i18next](https://react.i18next.com/) | Catalogues under `src/locales/{en,tr}/`, `useTranslation`, `<Trans>` |
| [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/) | Roles and states for dialogs, menus and live regions |
| [`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) · [`forced-colors`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors) | Motion guard and Windows high-contrast support |
