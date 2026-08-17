# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog:
https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Added

- The tray menu has a Close Overlays item. The preview and calibration overlays cover a whole screen, carry no title bar and stay out of the taskbar, so if one ever stops letting clicks through there is nothing left to close it with — and on Windows that has happened. The tray belongs to the desktop and cannot be covered, so this closes every overlay, puts the preview controls away and brings the main window back, without needing the window it is rescuing.

### Changed

- LED Setup is drawn in the app's own colours. It was still using the stock palette it was built against, so its greys read lighter, its amber duller, and its preview toggle was a near-white slab in an otherwise dark window. Nothing moves or changes behaviour; the page now matches every other surface.
- The window opens in whichever mode you left it in. Every launch forced compact and threw away the persisted choice, so anyone who preferred the wide layout re-selected it after every restart. The stated reason was a visible big-to-small flash during startup, which is not something that can happen: the window is created hidden and only shown once its size and position have been applied. Wide mode is now restored — at the size you last left it — before the window appears.

### Fixed

- Moving a Hue light on the Devices channel map no longer undoes the room map. Every save there rebuilt each light from scratch, so its name, its lock, and the zone the room map had put it in were quietly thrown away — and because the rebuilt record no longer said which entertainment area it belonged to, a second area's lights overwrote the first's. Moving a light that belongs to a zone now moves it within that zone, which is the position the lights actually follow, instead of writing one nothing reads. Saving also no longer deletes the lights the panel cannot see: it only ever shows one bridge's lights, so everything else — another area, or all of them while the bridge is unreachable — was being dropped.
- The wide window no longer opens taller than the screen. Its size was applied without ever checking the display it was about to land on, so on a short screen — or one with a tall taskbar — the bottom edge sat off-screen, taking the resize grip with it and leaving no way to drag it back. A size remembered from a larger monitor had the same effect after moving to a smaller one. The window is now shrunk to what the screen can hold, taskbars and docks excluded, and the smallest size it will allow comes down with it. It is only ever shrunk: a window smaller than your screen stays the size you chose.
- The signal readout no longer reports zeros in a Hue-only session. It always showed the USB numbers, and a session with no USB strip still carries a USB record — full of zeros — so "0ms" and "0 fps" sat under a Signal heading while the Hue bridge streamed perfectly, which reads as a dead pipeline. The heading now names the output being measured, and for Hue it shows the bridge's packet rate. Hue reports no latency figure at all, so that half reads "—" rather than inventing one.
- Searching for a WLED board, or testing one, no longer freezes the window. Both ran on the thread that draws the interface, so a board at an address nothing answers on locked the whole app until the probe gave up — two seconds for a search, and longer for a test, which makes two round trips with a pause between them. Both now run off to the side, and the interface stays live while they work.
- Adding a Hue light to the room map no longer produces two entries that behave as one. The new light was numbered by counting how many were already placed, which on a map with a gap in its numbering — every map written before v1.4.0 — hands it a number another light already has. From then on the two are indistinguishable: moving, locking or renaming either one changes both, and since nothing ever removes a light from the map, it could not be undone. New lights are now numbered past the highest in use.
- The first-run guidance banner no longer pushes the bottom of the window off-screen. It sat above the layout rather than beside it, so the layout kept its full height and slid down by however tall the banner was — and that strip was cut off, not scrollable, so nothing could bring it back. In the compact window the banner also grew to roughly half the height available, which took the entire scene row with it. The banner now shares the space instead of displacing it, and in the compact window its button moves to its own line so the text has room.
- On Windows, the overlays now keep marking their internal windows click-through for a few seconds after opening, instead of once at the moment they are created. The browser engine builds those windows on its own schedule and finishes after the overlay exists, so the single pass could run before there was anything to mark — leaving the overlay to swallow every click meant for the screen behind it. This is the suspected cause of the overlay making the app unclickable on Windows; it is a Windows-only code path and is being confirmed on hardware.

## [1.5.5]

### Fixed

- A failed update check no longer reads as a failed installation, and stops showing you a URL as the explanation. When the app could not reach the update server it announced "installation could not complete" — over an installation that was never attempted — and put the raw message from the update plugin, which contains the address of the release feed, where the explanation should be. It now says the server could not be reached, notes that nothing has changed, and keeps the raw message as a technical detail underneath. A genuine installation failure is unchanged.
- Status messages in Devices and the WLED picker use the same colours as the rest of the app. Four of them had been written against a raw palette that bypassed the theme, so a success or a failure looked subtly different depending on which panel it appeared in — and none of them had a high-contrast fallback, which left them unreadable in forced-colours mode.
- LED Setup no longer explains a problem in the app's own error codes. A layout it refused to accept was reported as, literally, "NO_LEDS_CONFIGURED: counts" — the same in Turkish, since it was never a sentence to begin with. All six refusals now say what is wrong in the language you are using, and the strip that carries them is announced rather than silently appearing.
- The LED Setup header stops breaking mid-phrase in a narrow window. The LED count, length and power sat in a group that absorbed the entire squeeze while the buttons beside it kept their width, so the text was the only thing that gave — worse in Turkish, whose labels run longer. The header now wraps as a whole, and the length-and-power figure stays on one line.
- Opening the LED preview now gets the main window out of the way, and closing the preview brings it back. The preview covers the screen it is testing, so the window it was launched from was sitting behind it for no reason. Opening the preview from the tray, with the window already away, leaves it that way — closing the preview only restores a window the preview itself hid.
- Locking a room-map object now also stops the keyboard moving it. The lock held against the mouse but not against the arrow keys or the rotate shortcut, so a pinned TV or strip could still be nudged out of place by a keypress — deleting was the only action that had ever checked.
- Nudging a Hue light that belongs to a zone moves it, and the position readout tells the truth. A light in a zone is positioned relative to that zone, and that is what the map draws — but the arrow keys and the coordinate boxes were reading and writing an older, separate pair of numbers the map ignores. So arrow keys appeared to do nothing at all, and the numbers on screen described somewhere the dot was not. Both now work in the same coordinates the map draws from.
- The room map has zoom buttons and a fit-to-view control. Zooming needed a scroll wheel or trackpad and fitting the room to the window needed a keyboard shortcut nothing mentioned, which left both out of reach for anyone working from the keyboard or a plain mouse. The control sits in the corner of the canvas and shows the current zoom.
- Right-clicking a Hue light no longer offers a Delete that does nothing. Hue lights come from the bridge and LumaSync cannot remove one, which the sidebar already knew — it hides the delete button there. The menu offered it anyway and the click was silently ignored.
- The window can be moved and closed while a dialog is open, and the dialogs themselves can be used from the keyboard. Both dialogs dimmed the entire window including the title bar — which is the drag surface and holds the window controls — so anything behind them became unreachable until the dialog was answered. The dimming now stops below the bar. Separately, opening a dialog moves focus into it, Tab stays inside it, Escape closes it, and focus returns to whatever opened it when it goes; the update dialog claimed to assistive technology that the rest of the window was inert while focus could still tab straight past it, and the unsaved-changes dialog announced itself as nothing at all. Escape on the unsaved-changes dialog means keep editing, never discard.
- Dragging the colour of a running test pattern glides instead of stepping. Every commit of the drag rebuilt the whole capture-and-output worker, expensive enough that the interface had to hold the update rate down to four a second — so a slow drag arrived as a handful of jumps. The pattern and its speed now live somewhere the running worker can see, so changing either reaches the lights without rebuilding anything, and the update rate has been raised to match. Changes that genuinely alter the shape of the output, such as editing the LED layout or switching monitor, still rebuild.
- A room-map Hue zone that the app refuses to accept no longer saves anyway. Every zone edit was sent to be checked, but nothing ever read the answer — the checks reported a refusal by returning it rather than by failing, and the editor was only watching for a failure. So a zone that reached past a wall, a channel moved into an area it does not belong to, or an eleventh light added to a zone that holds ten were all written to disk exactly as if they had been accepted, with nothing on screen. Refused edits are now undone and explained, and the size control stops at what the zone's position actually allows instead of at the room's width — which is what let a zone sitting against a wall be grown past it in the first place. The per-zone light limit was never enforced at all: the editor sent the change as already made, so the check compared it against itself and always passed.
- The chase test pattern is a comet again rather than a single lit LED. Its tail was specified as a physical 4 cm at an assumed 60 LEDs per metre — which works out to the same 2.4 LEDs on every strip between roughly 16 and 400, so what travelled the room was one bright LED, one at just over half brightness and one too dim to see. The tail is now at least five LEDs and grows with longer strips, capped so it never spans enough of the room to stop reading as a moving head. The rule that the tail must always cover at least one frame's travel is unchanged; it is what stops the comet skipping LEDs at speed.
- An LED test started with the lights off now lights a Hue bridge instead of reporting that nothing is connected. A test pattern turns output on — that is what it is for — and it always did so for a USB strip, because a strip stays connected whether or not a lighting mode is running. Hue was checked differently: the app asked whether a stream was open at that moment, which with the lights off it never is, so a paired and perfectly reachable bridge read as absent and the test fell back to showing the pattern on screen only. The test now opens the stream itself and closes it again afterwards, leaving a stream that was already running — because a mode is on, or the preview window is driving it — alone. LED Setup's test also stopped assuming USB: it now tests whichever outputs were last lit, so a Hue-only setup can finally use it.
- Switching device category in Devices starts you at the top of the new one. All the categories share a single scrolling panel, so scrolling down a long strip list and then clicking another category opened it mid-page, past its own heading.
- A Hue stream that fails to release the bridge on the way down is now retried instead of abandoned. Releasing the entertainment area is done by whichever part of the shutdown gets there first, and the others stand down so the bridge is not sent the same instruction three times — but that hand-off happened before the request, so if the request then failed, everyone else had already stood down. The bridge kept the area reserved and the next attempt to stream reported that something else was already using it, usually until the bridge was restarted. A failed release now puts the job back so the next part of the shutdown picks it up, and the failure is written to the log either way.
- The first frame sent to a USB strip is no longer swallowed by the board rebooting. Connecting a controller waits out the ~2 s reset that opening the port triggers on Arduino-style boards — but it then closes the port, and the first frame reopened it, resetting the board a second time with nothing waiting for it. Turning on Ambilight or a solid colour could start with a stretch of dark or garbled LEDs. The output path now waits the same settle once per connection, and nothing is added to any later frame.
- Switching everything off when one output refuses no longer strands the other. USB and Hue were stopped together, and a failure on either abandoned the whole transition: the output that did stop kept showing as active, and the lighting mode stayed on whatever had just been turned off. Each output's outcome is now recorded on its own, so the one that stopped is reported as stopped, the one that did not stays visibly on, and the mode reaches Off either way.
- Selecting a second Hue entertainment area while the first one streams shows that area's own lights. The runtime kept one cached channel list with no record of which area it belonged to and handed it to any area that asked, so the picker listed the streaming area's lights under the newly selected one — and any per-channel region you then set was saved against the area you thought you were editing, which meant the mistake outlived a restart. Existing overrides are left alone; re-setting a region that looks wrong is enough to correct it.
- "Continue in background" during an update download now does that. Dismissing the dialog only reset the updater to idle, while the download carried on reporting progress — and the first progress report after the click put the dialog straight back, so the button appeared to do nothing. Dismissing now hides what was dismissed and leaves the download alone; the dialog returns when the download finishes, since the app is about to restart, and a newer version found later is never hidden behind an earlier "Later".
- Switching the capture monitor in LED Setup moves the lights to that monitor. The choice was saved for next launch but never reached the running session, so Ambilight kept mirroring the old screen — and the next brightness or mode change re-sent the monitor it had been started with, putting it back even if something else had moved it.
- Changing the LED chip type takes effect without reconnecting the strip. SK6812 RGBW sends four bytes per pixel where WS2812B sends three, and the running encoder kept whichever setting was in place when the app started; the choice only applied on the next connect. Until then the strip was being driven with the wrong wire format, not merely the wrong colours.
- Pairing a Hue bridge takes effect straight away. Nothing told the rest of the app a pairing had completed, so the bridge stayed unknown to the reachability check and to the output banner until the next lighting-mode change — a freshly paired bridge could sit behind "no reachable output" while working perfectly. Choosing a different entertainment area had the same delay.
- "Check again" for an unreachable Hue bridge now shows that it is checking, and stays put. Pressing it re-armed the probe, which immediately cleared the gave-up state the button itself depended on — so the button vanished under the cursor and the only sign anything had happened disappeared with it. It now reads "Checking…" while the probe runs, and remains on screen if the bridge is still absent, rather than silently returning to a minute and a half of background polling.
- Clicking a control twice before it finishes now settles on what you asked for last. Three surfaces started work the user could re-trigger while it was still running, and each one let whichever request happened to finish last win: choosing a second monitor while the first switch was in flight discarded the new choice entirely and left the overlay, the picker and the saved setting on three different answers; turning an output off while turning another on could put the first one back; and a manual update check racing the one at startup could show the older answer. The monitor buttons also stay disabled while a switch is in progress.
- Two settings saved at the same moment no longer undo each other. All persisted shell state — window geometry, last section, lighting mode, the bound device, the room map and its grid settings — lives in one file that every writer read, modified and wrote back. Two writers overlapping meant the second read a snapshot taken before the first had landed, so it wrote back the older value and silently reverted whatever the first had just changed. Writes are now serialised, and a write that fails no longer blocks the ones queued behind it.
- Device cards use the width they are given, and their buttons stop spilling out of the card. The Devices panel laid every category out in two fixed columns at any window size, so a single paired bridge left a dead half beside it, and a narrower window squeezed both cards until the action buttons pushed past the card edge — measured at 560 px and below, and worse in Turkish, whose labels run several characters longer than the English ones. Cards now reflow to the space available, and a row of buttons wraps rather than overflowing.
- LumaSync stops looking for a Hue bridge that is not answering, and says so. On a different Wi-Fi network from the paired bridge, the app kept probing it silently for the whole session with nothing on screen to explain the permanent "no reachable output" state. It now gives up after a minute and a half of unbroken failure and offers a "check again" button; a brief drop on the right network still recovers on its own, because a single success clears the count.
- That giving-up now actually happens. Switching lighting mode re-derived the paired-bridge details into a new object even when nothing about the bridge had changed, and the probe restarted with a clean slate every time — so on a session with any normal amount of mode switching the failure count never reached its limit and the explanatory banner never appeared. The details are now only replaced when they genuinely differ.
- The wide window no longer offers Ambilight, Solid and the scene tiles when nothing is connected. Picking one started a mode with nowhere to send frames; the compact window had guarded this all along. The wide window now dims those controls, explains that no output is reachable, and offers a shortcut into Devices — while Off stays available, as always.
- The room map opens with the room framed and centred in the canvas. It measured the canvas only on the very first render, which happens while the saved map is still loading and the canvas does not exist yet, so the measurement never arrived and every visit started at default zoom in the top-left corner.
- LED Setup's "Run test pattern" lights the strip. It called a command that checked whether a device was connected and then reported success without building a frame, an encoder, or sending anything, while the editor showed a pulsing "Output active" badge over output that did not exist — and the marker animation meant to walk the strip advanced an index nothing on screen rendered, so neither half of the feature was real. The button now drives the same pattern engine as the LED preview, sizes the pattern from the LED counts currently in the editor rather than the last saved ones, and refuses with a reason when there is no layout to test.
- LED test patterns now run with the output settings the rest of the app uses. They ignored the configured chip type, firmware profile, and colour correction entirely, so an SK6812 RGBW strip was driven through the WS2812B encoder and an Adalight controller through the LumaSync v1 header — the test lit nothing, or the wrong colours, on exactly the hardware it exists to verify.
- Test patterns reach a WLED strip, and stopping one restores the previous mode. On a WLED-only setup the test was reported as preview-only and never lit the strip, and Stop was silently rejected, leaving the pattern running with no way to end it.
- The chase pattern is a comet: a full-brightness head with a trailing fade, holding its speed and size the whole way round. It previously skipped LEDs at the medium and fast speeds, ran nearly three times faster along the long edges than the short ones, and reached the strip at a fraction of the requested brightness.
- Changing a test pattern's colour or speed no longer restarts its animation from the beginning.
- Closing the LED preview no longer switches the lights off when the test is not what is driving them.
- The digital-twin overlay opens on the selected display when launched from LED Setup, and its edge ribbons line up with the LED dots they mirror.
- Stopping the Hue stream from the Devices tab no longer has the app put it straight back. That button reached the stream through a path that left the cached stream status untouched, so the health check running moments later could still read "running" and restore Hue as an active output — undoing the stop the user had just asked for.
- A save failure now raises its warning on the surface that failed. One "could not be saved" flag was shared between the USB strip list and the Hue channel map, so failing to add a strip put a "position not saved" warning inside the Hue panel, and a failed channel move accused the USB strips of not saving — with whichever failed last resetting the other banner's timer.
- Adding a floor plan to the room map says so when it fails. A rejected file picker or a failed copy left the map unchanged with nothing on screen and nothing in the log, so the click simply appeared to do nothing.
- Selecting a Hue channel in the room map shows and locks that channel, not whichever one happens to sit in the matching array slot. On maps saved by v1.4.0 or earlier — where deleting a channel left a gap in the list — the property bar showed a neighbouring channel's coordinates or went blank, and a locked channel could be dragged.
- Pairing a Hue bridge now fills the entertainment-area list on its own. It arrived empty and needed a manual "Refresh areas" click, and re-pairing a bridge asked for the areas with the application key the bridge had just replaced — so a bridge that had rejected the old key answered a successful pairing with "re-pair is required".
- On macOS, LumaSync checks the Screen Recording permission rather than inferring it. Every failure of one system call was being read as a missing permission, so the app could tell someone to grant access they had already granted; meanwhile the display picker needs no permission at all, so a genuinely blocked user saw every screen listed as usual, chose one, and got a mode that lit nothing. One honest limit: the check cannot separate "refused" from "never asked", so the wording asks you to check the setting rather than claiming you denied it.
- A screen capture that fails now reaches the user, whether it fails on the way up or hours into a session. The result of starting Ambilight was discarded outright — the backend reports that kind of failure inside an otherwise successful reply, and nothing on screen was reading it — while a display unplugged mid-stream only incremented a counter in the log. The health figures made it worse by freezing at the last good frame during an outage, so a capture that had stopped working kept reporting a healthy frame rate.
- A lighting mode the backend refuses to start no longer appears switched on. The failure notice and an Ambilight toggle reading ON could sit on screen together, and the mode that never ran was saved as the one to restore — so the next launch opened in a state the app had already failed to reach.
- A WLED strip is remembered and re-bound on the next launch. USB strips have always had a remembered port and automatic recovery; WLED had neither, so a network strip was reconnected by hand every time the app started, and nothing on screen said which device was bound.
- Leaving the address blank when adding a WLED device no longer produces a raw error string. The hint text invited exactly that, and the request went out with no address at all, so the refusal came back as an untranslated internal error.
- An expired Hue application key says so instead of reporting an empty entertainment area. The bridge's refusal was caught and turned into "this area has no channels", which sent people looking at their Hue setup for what was only a re-pair.
- The serial link-saturation figures in Runtime telemetry appear. Both values were dropped in transit between the backend and the panel, so the panel had always shown them blank.
- A WLED strip longer than about 487 LEDs now lights correctly. Every frame was sent as one oversized datagram, which the network then had to split; on Wi-Fi — where most WLED boards live — a lost piece takes the whole frame with it. Frames are now split at a size that crosses the network intact, and only the final piece tells the strip to display, so partial frames no longer flash. This is what makes "use WLED for long strips" true past 487 LEDs, which is where the USB serial path already ends.
- The non-DDP WLED protocol option sent malformed packets and has been replaced. Its frames put the timeout where WLED expects the protocol number, so the device misread every colour and wrote them to the wrong LEDs — the packet matched no protocol WLED defines. It now speaks DRGB, and switches to DNRGB by itself on strips too long for a single packet. Nothing in the interface ever offered the broken option, so this can only have been reached by hand-editing settings; such a setting is migrated on read.
- Testing a WLED bridge no longer reports success it did not verify. The test asked the device for its details over HTTP — which is real, and still cross-checks the LED count — but then sent one UDP frame and called that a round trip. UDP has no acknowledgement, so a wrong realtime port, a rejected format, or a dropped packet all passed. It now checks the port against the device's own setting, and after sending asks the device whether it entered realtime mode: a confirmed result and a "sent, not confirmed" result are now different answers. The timing figure is labelled send latency, because that is all it ever measured.
- Starting a mode whose calibrated strip length disagrees with the WLED device's LED count now says so. WLED lights the first N LEDs of a short frame and truncates a long one, so the strip half-responds — which reads as a wiring fault and sends people to their solder joints. Lighting continues; the mismatch is now reported with both numbers.

### Added

- A beta update channel, switchable in Settings → System. With it on, LumaSync also offers prereleases; with it off nothing changes. Beta is a superset — a stable release still reaches you on the beta channel, so a tester is never stranded on an older prerelease. The description says plainly what CI does and does not prove about a prerelease: it builds and tests them, but never launches the packaged installer itself.
- Each log file now opens with the version, build type and update channel that wrote it. Stable and beta are one installation writing the same file in turn, so nothing in a log said which build produced a line.

### Changed

- A release can no longer be published from a tag that goes backwards. The tag-versus-tree check added earlier compares only the `X.Y.Z` core, so tagging a prerelease of a version already released passed every step and would have offered users a build older than the one they run. The tag must now also be newer than every existing release tag.
- A prerelease publishes its version's release notes instead of needing its own changelog section.
- Linux screen capture now downscales each frame before analysing it, as macOS and Windows already did. A 4K X11 display was handing all 8.3 million of its pixels to the analysis pass twenty times a second and now walks about 230 thousand — that ratio is arithmetic read off the code, not a measurement: nobody has run it on Linux hardware, which stays the least-exercised of the three platforms.
- The LED preview popup has one always-available close control, and reopens where it was last dragged.
- Runtime telemetry in Settings adopts the amber Rev 07 design language it had been left out of.
- The interface language picker is a dropdown that lists each language by its own name.

### Security

- The Hue application key is no longer written to `shell-state.json`. Both Hue secrets now live only in the OS keychain — macOS Keychain, Windows Credential Manager, Linux Secret Service — and the CLIP v2 command surface resolves the key there rather than taking it from a plaintext file. Two limits worth stating plainly: on a platform with no working keychain (a Linux box without D-Bus) both keys still land on disk, because the alternative is an app that cannot pair; and upgrading does not scrub the existing file at install time — the key is removed on the next launch, once the migration has verified the keychain holds a copy, or on the next successful pairing.
- Cleared the `extract-zip` symlink path-traversal advisory (GHSA-jmr9-qjv8-65gv), which reached the tree through the WebdriverIO E2E toolchain (dev-only). The package is unmaintained and its last release is the vulnerable one, so the exit is pinning its parent `@puppeteer/browsers` to 3.x, which dropped the dependency outright.

## [1.5.4] — 2026-08-10

### Fixed

- Hue Bridge Pro can now be paired. The bridge serves its local API over HTTPS only, so LumaSync's pairing, IP verification, and credential-validation calls — which were still on plain HTTP — never reached it, and the failure surfaced as a generic "Pairing failed" on a bridge that discovery had found without trouble. These calls now try HTTPS first and fall back to HTTP for older bridges, which are unaffected.
- A rejected link button is no longer reported as "Auth error — your credentials have expired". Pairing without pressing the bridge button now shows the awaiting-link-button state it always should have.
- Room-map template buttons and the calibration save button expose proper accessible names and busy state to screen readers.

### Changed

- Room-map drag handling collapses a redundant find+map pass into a single traversal.

### Security

- Resolved RUSTSEC-2026-0235 (`rkyv` out-of-bounds read): the advisory reached LumaSync through an unused optional dependency of `tauri-plugin-log`, whose 2.9 release drops that chain entirely. The `cargo audit` CI gate is green again.
- Fixed an SSRF in the Hue stream-readiness check.

### Internal

- Release pipeline migrated to `tauri-action` v1.
- Branch protection now requires the CI checks that actually run; the previously required `typecheck` context no longer existed, so every pull request was permanently blocked.
- Dependencies refreshed across all three ecosystems (Rust, frontend, GitHub Actions), including TypeScript 6 → 7 for the build toolchain.

## [1.5.3] — 2026-06-25

### Added

- Hue active-streamer banner now clears on its own: while an entertainment area is held by another active streamer, readiness is re-probed every 3 s (instead of the 15 s healthy cadence) and the banner dismisses within ~3 s of the foreign session releasing — no manual revalidate needed.
- `HUE_STOP_TIMEOUT_PARTIAL` runtime faults now surface a "Retry Stop" action hint, matching the inline recovery CTA in the device panel.

### Changed

- Hot-path Rust→JS events (60 Hz edge signals, tray/shell lifecycle) are emitted to the main settings webview only, so calibration-overlay windows are no longer woken on every frame — lower idle CPU whenever an overlay window exists.
- Hue background readiness refresh migrated from a fixed `setInterval` to a visibility-aware recursive `setTimeout`, pausing while the window is hidden and re-arming on focus, consistent with the rest of the polling discipline.
- RoomMap template selector migrated to the amber Rev 07 design tokens.
- The Hue stream-health check now pauses while the tray window is hidden and re-checks immediately on re-focus, trimming needless background bridge traffic — consistent with the rest of the polling discipline.
- Gamma-correction lookup tables are no longer rebuilt every frame (previously once per Hue channel per frame, and once per Adalight/SK6812 serial packet); they are computed once and reused, with the default 2.2 profile borrowing a shared precomputed table — lower idle CPU on the output hot paths with byte-identical output.
- Hue stream activation and reconnect now reuse a single HTTP client when fetching per-bulb gamut metadata instead of constructing one client per light.
- Rust dependencies refreshed to latest stable: `screencapturekit` 1.5.4 → 8.0.0 (macOS capture — the synchronous capture API is source-compatible, so capture code is unchanged) and `keyring` 3 → 4 (OS keychain — classic API retained via its `v1` feature), plus `tauri` 2.11.3 and the remaining tree via `cargo update`.
- Frontend toolchain refreshed: pnpm 10.33.2 → 11.9.0 (pnpm 11 relocated settings out of `package.json` into a new `pnpm-workspace.yaml`), `vite` 8.0.16 → 8.1.0, `@vitejs/plugin-react` 6.0.2 → 6.0.3.

### Fixed

- macOS: fixed a launch crash (`dyld: Library not loaded: @rpath/libswift_Concurrency.dylib`) that affected every install of 1.5.2 on machines without Xcode. The Swift runtime deployment target is now pinned across all build paths so the screen-capture stack links against the system Swift concurrency library (present on every macOS 12+) instead of a build-machine toolchain path; a release-pipeline guard now blocks any future binary that would regress this.
- Hue auto-reconnect could stall permanently in the "Reconnecting" state when a status poll raced the reconnect monitor for the same shutdown signal; the monitor now keys its guard off an explicit in-progress flag, so the restart always proceeds and the stream self-heals.
- Shutdown hardened: the lighting-worker teardown step is now time-bounded (1.5 s) so a slow worker join can no longer starve the Hue entertainment-mode deactivate under the shutdown watchdog (which previously risked leaving the bridge with a phantom active streamer). On Windows, screen-capture teardown is detached onto its own thread so it no longer briefly freezes the UI when switching lighting modes.
- Room-map template buttons now expose an explicit accessible name (`aria-label`) for screen readers.
- Transient USB disconnect / unsupported-port notices no longer leak their auto-dismiss timers if the view unmounts or the effect re-runs first.

### Security

- Resolved RUSTSEC-2026-0185 (7.5 high) by bumping the transitive `quinn-proto` dependency to 0.11.15; `memmap2` bumped to 0.9.11 (RUSTSEC-2026-0186). The `cargo audit` CI gate is green again.
- Bumped the transitive `tar` crate to 0.4.46 (PAX header desynchronization advisory).
- Pinned the transitive `undici` (dev/test only, via jsdom) to ≥7.28.0, clearing the open advisories for SOCKS5 cross-origin request routing and TLS certificate-validation bypass on the 7.23–7.27 line.

## [1.5.2] — 2026-05-05

### Added

- Keyboard input for per-edge LED counts and stand-gap in LED Setup, allowing direct numeric entry instead of stepper-only interaction.
- First close-to-tray OS notification guides new users who wonder where the app went after closing the window.
- Frontend `console.*` calls are now bridged to `tauri-plugin-log`'s file sink, so `[webview]` records appear alongside Rust log entries in the platform log file — runtime debugging no longer requires an open DevTools window.

### Changed

- Polling discipline tightened across telemetry and Hue health checks: all intervals pause when the window is hidden and resume on visibility, reducing CPU and battery draw when LumaSync is running in the background.
- Boot sequence streamlined: Hue credential validation is de-duplicated (previously fired twice on some paths) and the updater check is hoisted to run earlier, so the first-launch experience is snappier.
- RoomMap editor migrated to amber Rev 07 design tokens with a 32 px minimum tap-target floor throughout the dock and toolbar.
- Compact-mode deep-links to non-LIGHTS sections now auto-expand to full-window mode so the target panel is always visible.
- Window position persistence anchored by window center instead of top-left corner, with a monitor-clamp guard that snaps the window on-screen if the saved position falls outside the current display geometry.
- Release pipeline (`release.yml`) now runs the same Rust hardening gate as `ci.yml` before any tag-triggered build — `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --all-features` — closing the gap that previously let lint regressions or integration-test failures slip through to a release artefact.
- CI: `pnpm/action-setup` bumped v4 → v6 to clear the Node 20 deprecation warning; workflow concurrency and release idempotency (`allowUpdates`) tightened.
- Rust deps: `mdns-sd` 0.13.11 → 0.19.1 (major); `ResolvedService` surface adapted in the mDNS registry; Cargo.lock transitive graph refreshed on the 2.11.x Tauri line.

### Fixed

- macOS lifecycle hardened: Cmd+Q, tray Quit, and Ctrl+C now all route through a single `kick_off_shutdown_and_die` path. Two follow-up regressions from the initial rewrite are resolved — the `tauri-plugin-single-instance` socket is no longer leaked on watchdog exit (which caused the next dev launch to exit within ~50 ms), and `stop_hue_stream` is detached onto a worker thread with a 1.5 s abandon timeout so it cannot blow the 4 s watchdog.
- macOS tray icon now ships as a template image (monochrome silhouette), so it renders at the correct size and respects Dark/Light menu bar mode.
- Non-USB serial port types (Bluetooth, PCI, Unknown) are rejected with `PORT_UNSUPPORTED` before `serialport::open()` is called. Previously, opening `/dev/cu.Bluetooth-Incoming-Port` silently accepted writes while the LED strip stayed dark.
- Boot output-target recovery: persisted empty `[]` targets are no longer overwritten with defaults on every launch; the `PORT_UNSUPPORTED` subscriber auto-adds Hue when a bridge is paired and Hue was not already active; a separate boot path prevents paired-Hue-only users from being stranded in OFF state on restart.
- WLED backend–frontend wire mismatch: request/response payload shapes for discover, connect, and test were misaligned, causing the picker to render empty and the Connect/Test buttons to fail with `MissingField`. All three command pairs are now aligned; `WledTestResponse` reports a real round-trip in milliseconds.
- WLED: additional validation rejects `led_count == 0` at connect time (`WLED_INVALID_LED_COUNT`) and extends the SSRF guard to also block loopback, unspecified, multicast, and broadcast addresses (`WLED_INVALID_IP`).
- Output-target delta-stop no longer evicts a chip from active membership when the underlying stop call fails — the chip stays active so the user can retry, and a transient banner identifies which target needs attention.
- Hue stream shutdown emits a DTLS `close_notify` alert and de-dupes foreground/background deactivate calls via a single-shot atomic token, so the bridge clears its "active streamer" slot immediately and the latent `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` 403 on the next session start is eliminated.
- RoomMap rename dialog: ESC now cancels from any focused element; Tab cycles input → cancel → confirm; `aria-labelledby` IDs are generated with `useId()` to prevent DOM collisions on re-mount.

### Security

- WLED IP validation extended: loopback (127.0.0.0/8), unspecified, multicast, and broadcast addresses are now rejected with `WLED_INVALID_IP`, layered on top of v1.5.1's parser-level SSRF guard.

## [1.5.1] — 2026-05-01

### Security

- Bump `rand` 0.8.5 → 0.8.6 and `rand` 0.9.2 → 0.9.4 to clear RUSTSEC-2026-0097 (unsoundness with a custom logger using `rand::rng()`); both reach LumaSync transitively through `tauri-plugin-notification` and `xcap`. The remaining `glib 0.18.5` Linux-runtime warning (RUSTSEC-2024-0429) requires a Tauri/gtk major bump and is tracked for v1.6.

### Changed

- Rust deps: Tauri 2.10.3 → 2.11.0 (and the matching `tauri-build`, `tray-icon`, `wry` chain), `reqwest` 0.13.2 → 0.13.3 (Dependabot minor-and-patch group).
- Frontend deps: `@tauri-apps/api` and `@tauri-apps/cli` 2.10.1 → 2.11.0, `jsdom` 29.1.0 → 29.1.1 (Dependabot minor-and-patch group).

## [1.5.0] — 2026-04-28

### Added

- Hue Zone system: entertainment areas now map to logical zones with zone-relative coordinates, AR-locked size slider, center/border color picker, and a live zone bounds visual on the room map canvas — zones render simultaneously with individual show/hide toggles
- HSV color picker: hue/saturation/value wheel replaces the flat RGB swatch in the Hue zone inspector, with a portal-aware popover that escapes compact-mode clipping
- WLED DDP bridge: UDP discovery (`_wled._tcp.local.` via mDNS), connect, and test-pattern flow; WLED appears as a first-class output target alongside USB and Hue
- Linux X11 screen capture via xcap — LumaSync now ships on all three desktop platforms (macOS, Windows, Linux)
- SK6812 RGBW host-side encoder: white channel derived as `W = min(R, G, B)` extraction, chip type persisted per device; selector exposed in device settings
- Expanded USB VID/PID allowlist: PL2303, CH341, CP2104 (Silicon Labs CP2102), and FT232H added alongside the existing CH340 and FT232R entries
- Hue per-bulb gamut clip: `gamut_type` (A/B/C) is fetched per light during area activation and applied in the DTLS frame builder hot-path with luminance-preserving xy→RGB mapping
- Hue OS keychain credential migration: bridge username and PSK are moved from plaintext `shellStore` to the platform keychain (macOS Keychain, Windows CredMan, Linux Secret Service) with an idempotent, downgrade-safe migration path
- mDNS bridge discovery: Hue bridges are discovered via `_hue._tcp.local.` with cloud API as fallback; shared mDNS responder also serves the WLED browser to avoid `SO_REUSEPORT` contention on macOS
- First-run onboarding banner: three-step progressive inline flow guides new users from device pairing through first Ambilight activation; dismissed permanently after completion
- Offline USB strip reconnect affordance: a reconnect button appears when a paired strip's port is unavailable on launch, replacing the silent failure path
- Beta update channel scaffold: `updateChannel` shell state lets opted-in users receive pre-release builds via a separate `latest-beta.json` endpoint; stable channel behavior unchanged
- Windows hardware-accelerated downscale scaffold: frame builder wired to accept a downscale hint for the Windows capture path (full implementation follows in a subsequent patch)
- RoomMap editor full rework: tabbed dock with type-aware inspector dispatcher (USB strip / Hue zone / furniture / TV anchor), amber Rev 07 chrome throughout, multi-strip pair-as-strip flow, port change on paired strips via inline dropdown, and all Hue zones rendered simultaneously on the canvas

### Changed

- Hue zone identity collapsed onto `borderColor`; `HueZone` type unified into a `Zone` discriminated union (`zoneType` field) under the `room_map` module — schema version migrated 1→2 with an automatic shim so existing room maps open without data loss
- RoomMap editor canvas drag-and-drop now works correctly in WKWebView; Hue channel drags clamp to the bound zone regardless of selection state
- Lighting mode bootstrap reworked: ambilight state hydrated from persisted config on cold start (USB-only path); saturation and smoothing alpha preserved across brightness-only fast-path tweaks
- Serial connect and health-check now unblock the IPC dispatcher during the operation, eliminating UI freezes on slow port enumeration
- USB serial auto-reconnect broadcasts connection events with a structured lifecycle so the UI reacts without polling
- Compact mode ambilight brightness and smoothing controls mirrored into full settings for parity; Adalight brightness lock applied in compact mode
- App icon body inset to 720×720 to match the macOS dock squircle visual weight
- Rust deps: `keyring` 3.x and `mdns-sd` 0.13 added; `tokio` held at 1.52.1
- Frontend deps: i18next, jsdom, vite bumped (patch/minor); no breaking changes
- GitHub Actions: Linux runner bumped from ubuntu-22.04 to ubuntu-24.04 across CI and release workflows; `libgbm-dev` added to apt deps for xcap linker

### Fixed

- Latent DTR auto-reset: 2-second bootloader settle delay added after DTR toggle so firmware has time to initialize before the first frame
- Ambilight cold-start: persisted ambilight profile now hydrates correctly when the app launches directly into ambilight mode without a prior UI interaction
- Hue color flash on stream start and dim-on-saturated artifact: color correction order aligned so the first frame does not briefly push an unintended hue
- USB auto-pair race: connection state gate added so a rapid disconnect/reconnect sequence no longer leaves the port handle in a leaked state
- Adalight firmware profile picker: brightness lock override now correctly applies in compact mode matching full-settings behavior
- `InspectorNumberField` re-edit: committing a value with Enter no longer locks the field into read-only display until blur
- LED setup canvas: arrow direction and start-anchor visualization now match the backend canonical traversal under both CW and CCW, including all eight corner anchors and the bottom-gap variants
- LED setup cold-start: persisted display selection now derives default per-edge LED counts on launch instead of leaving the editor at 0/0/0/0 until a manual monitor change
- Calibration overlay refresh race: opening the overlay after a frontend refresh no longer fails with `OVERLAY_WINDOW_OPEN_FAILED` from a stale Tauri window-label registry entry
- First-run onboarding banner: persisted lighting mode now primes the LIGHTS step guard on cold start so returning users skip the gating ribbon
- RoomMapEditor mousemove listener thrashing: pan/zoom interactions no longer detach and re-attach the canvas listener every frame

## [1.4.0] — 2026-04-24

### Added

- USB per-LED sampling: each LED now samples its own edge region of the screen (anchored to the room map's edge counts, start anchor, direction, and bottom gap), replacing the single-zone hardcode shipped in v1.3; baud budget adapts dynamically so 60 LEDs run at ~60 FPS and 200 LEDs at ~19 FPS within the 115200 baud limit
- LedSink trait: a common `start / send_frame / stop` abstraction over the serial output bridge, laying the foundation for WLED (v1.5) and OpenRGB (v2.0) sinks
- Multi-monitor capture: stable display IDs on macOS (SCDisplay) and Windows (device_name) with automatic primary-display fallback on unplug; selected display persists across restarts
- Per-channel color correction: independent R/G/B gamma tables, Kelvin white-balance multipliers, and BT.601-luminance saturation trim — tuned once per strip, applied on the hot path before smoothing so USB, Hue, and the edge-signal preview stay visually consistent
- Adalight firmware profile: encoder dispatch selects between LumaSync-native framing (default) and the widely-used Adalight `"Ada"` header format; profile is persisted per device
- Serial handshake round-trip: PING/PONG opcode protocol with `SerialHealthReport` and coded `SerialHealthCode` status; firmware implementation ships in the companion hardware repo's v1.5 update
- Platform notifications: `tauri-plugin-notification` + `tauri-plugin-process` wired end-to-end; permission banner asks once, OS-level toasts for connection, stream, and update events; `open_log_dir` command exposes the app log directory
- FPS/latency HUD: StatusBar fourth pill shows live frame rate and end-to-end latency with green/amber/red thresholds (45/25 FPS); always visible while Ambilight is active
- Global ErrorBoundary: catches render faults and surfaces a localized fallback card with Show logs, Restart, and Copy error actions instead of a blank tray window
- Keyboard shortcuts: `Alt+1/2/3` (Ctrl on Windows/Linux) to switch modes, `Alt+,` / `Cmd+,` to open Settings; TR-layout-safe key resolution with input-focus guard
- Hue richer pairing errors: CLIP `error.type` is now split into `LINK_BUTTON_NOT_PRESSED`, `DEVICETYPE_INVALID`, `BRIDGE_BUSY`, and `RATE_LIMITED` — each surfaces a distinct localized message
- Hue room archetype enrichment: entertainment area list fetches CLIP v2 archetype data in parallel (`tokio::join!`) and surfaces it in the area-select UI
- Hue intensity presets: Subtle (EWMA 0.15) / Moderate (0.35) / Intense (0.60) coefficient shortcuts for fast ambience tuning

### Changed

- CI hardening: 3-OS matrix (ubuntu-22.04, macos-latest, windows-latest) with `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check --all-targets --all-features`, `cargo test --no-run`, and `cargo audit` on Linux; CodeQL JavaScript/TypeScript scanning on push, PR, and weekly schedule; `dependency-review-action` with MIT/Apache/BSD/ISC allow-list on PRs
- Rust toolchain pinned to stable via `rust-toolchain.toml` with `rustfmt` and `clippy` components
- Node.js bumped from 20 to 22 across CI and release workflows
- Log rotation set to 5 MB (KeepOne in release builds, KeepAll in debug)
- Hue 403 re-pair contract tightened: only a 403 with CLIP `type == 1` triggers re-pair; other 403 responses are treated as transient and do not interrupt the session
- Lighting responsiveness unified: the continuous smoothing slider and the Hue-only intensity preset merged into a single three-step control (Subtle / Moderate / Intense) that drives both USB and Hue EWMA paths at once; legacy persisted state (`smoothingAlpha`, `hueIntensityPreset`) still reads through a fallback chain so no migration is required
- Hue pipeline now applies the full color-correction chain (gamma + Kelvin + saturation), matching the USB encoder order byte-for-byte so strip and bulbs stay visually consistent
- Rust deps: reqwest rustls chain updated (aws-lc-sys 0.37 → 0.40, rustls-webpki 0.103.10 → 0.103.13, rustls 0.23.37 → 0.23.39)
- Frontend deps: `@tauri-apps/plugin-notification` and `@tauri-apps/plugin-process` added; minor/patch bumps across the React/Vite/Vitest ecosystem
- GitHub Actions: `actions/checkout` and `actions/setup-node` pinned; `pnpm/action-setup` held at v4 with pnpm 10 explicit pin

### Fixed

- Silent `try/catch` purge: 7 swallowed errors in `App.tsx` and `SystemSection` now route through the structured logger with contextual prefixes
- Preexisting Rust test bitrot: `hue_onboarding_tdd` fixtures and `ambilight_capture` import blocks had drifted from the current module layout; fixed so `cargo test` compiles cleanly in CI
- 14 clippy pedantic lint warnings resolved as a baseline cleanup pass
- Ambilight settings persistence: pending `lightingMode` writes are now flushed on `pagehide` and `visibilitychange`, so saturation and black-border toggles survive Cmd+R / tray close / reload cycles
- Color correction + firmware profile payload: the mode normalizer now preserves these fields end-to-end instead of stripping them before `set_lighting_mode` invoke, so slider commits actually reach the worker

### Removed

- 5 orphan settings components absorbed by M6: `LanguageSection`, `StartupTraySection`, `AboutLogsSection`, `CalibrationSection`, `ConfigurePage` — along with 2 orphan test files
- `SidebarFpsWidget` retired; the StatusBar FPS/latency pill supersedes it

### Security

- CodeQL JavaScript/TypeScript scanning added to CI (push, PR, and weekly Monday schedule)
- `dependency-review-action` gates PRs on license allow-list (MIT/Apache/BSD/ISC) and blocks high-severity CVEs
- `cargo audit` runs on Linux CI step; 8 transitive RUSTSEC advisories resolved by bumping the reqwest/rustls chain

## [1.3.1] — 2026-04-23

### Fixed

- CHANGELOG: de-duplicated `[1.1.0]` heading; the March 2026 foundation entry was never tagged and is now demoted to a historical sub-section so the release workflow's changelog extractor no longer silently drops it

## [1.3.0] — 2026-04-22

### Added

- Compact UI mode with dual-sized window (compact 320×480 / full 900×620), custom overlay title bar, and accent theme system driven by a new `UIMode` contract
- CompactLayout view with quick-access mode presets, scene tiles, and integrated mode toggle for a tray-style experience
- LightsSection redesign (M6): mode selector, scene presets, ambilight profile sliders, and live device/status visualisation
- StatusBar with mode, device, and stream indicators alongside the new shell chrome
- UpdateModal rewrite covering four states (available / downloading / installing / error) with i18n-backed labels
- Hue Bridges section redesign (B-08): card state classes, pill variants, traffic bar label row, four-step pairing tracker with failure state, area-select label, conflict/repair/offline banners, and action buttons aligned to all 17 defined states
- Edge signal preview panel: the ambilight worker now emits a throttled `ambilight://edge-signal` Tauri event (~10 Hz) with top/bottom/left/right RGB samples, rendered as live linear gradients next to a primary-display tile
- Runtime telemetry meta pill showing live `Δ` frame latency and `Σ` FPS sourced from `get_runtime_telemetry` while Ambilight is active; polling pauses when the tab is hidden
- Ambilight saturation control: luminance-preserving Rec.601 factor (range 0.5–2.0, identity 1.0) stored as an `AtomicU32` in the worker's live settings, applied on the hot path before smoothing so USB LEDs, Hue channels, and the edge-signal preview stay visually consistent; exposed in Lights as a 50–200% dial
- Unified scene preset catalog (`src/features/mode/model/scenePresets.ts`) with a `brightness` field, shared by Compact and Lights; active preset is derived from the current SOLID payload so selection survives view switches and app restarts
- Dock "+" add-zone affordance rendered as disabled with a tooltip, surfacing multi-zone support as a known-future feature
- `EdgeSignalPayload` / `EDGE_SIGNAL_EVENT` exported from the mode contract module for typed event wiring
- Jules agent documentation: hard constraints, security rules, and architecture data-flow map to guide automated security/performance scans
- `LedRoomCanvas`: read-only SVG illustration of the monitor + desk scene with LED dots distributed per edge, a #1 start marker, and a direction arrow — driven purely from `LedCalibrationConfig`
- `deriveDefaultCounts(display)`: frontend heuristic that assigns sensible per-edge LED counts from monitor resolution and aspect ratio so auto-selected displays fill the canvas on first run without a template picker

### Changed

- Compact/full UI mode transition now uses a single content slot with sequential fade + resize + fade and easing matched to the window animation, eliminating the progressive-clipping artefact where the incoming layout overflowed the still-animating window
- Removed the orange edge-sweep animation from window mode transitions; the simpler fade + resize flow remains
- LED Setup redesigned to a single-screen stage + 268px dock layout: the three-step display/template/editor wizard, template picker, and draggable editor canvas are gone; counts are adjusted directly in the dock and the test pattern runs in place with a preview/output HUD overlay on the canvas
- LED Setup dock exposes the full strip topology: partial-edge setups (e.g. LEDs only on the top) are allowed (0-count edges), monitor stand gap (`bottomMissing`) has a dedicated stepper, LED direction toggles between CW / CCW, and start anchor is driven by edge tabs + Start/End/Gap-R/Gap-L endpoint buttons so all 10 `LedStartAnchor` positions are reachable. `LedRoomCanvas` now renders the stand gap and places the `#1` marker on the gap-adjacent LED for `bottom-gap-*` anchors
- Calibration validation: 0-count edges are now accepted as long as `sum > 0` (`NO_LEDS_CONFIGURED`); stand gap wider than the bottom edge now fails with `BOTTOM_MISSING_EXCEEDS_BOTTOM`; `normalizeLedCalibrationConfig` auto-clamps `bottomMissing` to bottom count and auto-heals `startAnchor` when its edge is zeroed out
- Hue stream health polling migrated from `setInterval` to recursive `setTimeout`, preventing overlapping probes when a health check takes longer than its interval and stopping polling as soon as the stream is detected dead
- Internationalisation sweep: DeviceSection cell labels (Area, Protocol, Ch, Rate, Status, Error, Retries, Next, Fault, Config, Credential, Invalid), traffic bar Stream label, DTLS streaming subtitle, display card ID/Scale labels, previously-missing wizard step keys, UpdateModal note kind tags moved to `updater.noteKind.*`, RenameDialog Cancel/OK buttons in RoomMapEditor, and StatusBar keyboard hint labels (mode / settings) — EN + TR locales kept in sync
- Test layout: all colocated `*.test.ts(x)` files relocated into `__tests__/` subdirectories and CLAUDE.md updated to document the convention
- Rust dependencies bumped: `tokio` 1.50.0 → 1.52.1, `openssl` 0.10.76 → 0.10.78
- Frontend dependencies bumped (minor/patch): `i18next` 26.0.4 → 26.0.6, `react-i18next` 17.0.2 → 17.0.4, `tailwindcss` + `@tailwindcss/vite` 4.2.2 → 4.2.4, `typescript` 6.0.2 → 6.0.3, `vite` 8.0.8 → 8.0.9, `vitest` 4.1.4 → 4.1.5, `happy-dom` + `@happy-dom/global-registrator` 20.8.9 → 20.9.0
- GitHub Actions bumped: `actions/checkout` 4 → 6, `actions/setup-node` 4 → 6, `pnpm/action-setup` 4 → 6
- Dependabot configuration added for Cargo, npm, and GitHub Actions ecosystems so future dependency updates land as reviewable PRs
- Linux CI hardened with `DEBIAN_FRONTEND=noninteractive` to prevent apt-get prompts from hanging the runner
- `.gitignore` now ignores `.planning/` and `.jules/` recursively so local planning artefacts never leak into status
- Removed legacy `.jules` tracking files from the repository

### Fixed

- Hue stream polling overlapping probes when a health check ran longer than the interval (migrated to recursive `setTimeout`)
- DeviceSection and SettingsLayout test suites updated for the b06 redesign markup
- LightsSection test suite: added a `Trans` mock so rich-text i18n fragments render deterministically in jsdom
- Removed unused imports that were failing `tsc --noEmit` with TS6133 after recent refactors
- Hardcoded fallback strings in Device and Updater UIs replaced with `t()` keys so EN/TR locales render consistently

### Performance

- RoomMapEditor: isolated high-frequency mouse-coordinate state into a dedicated child that uses native DOM listeners with `requestAnimationFrame` throttling, eliminating full-editor re-renders on cursor movement
- SettingsLayout: wrapped in `React.memo` to prevent polling-triggered re-renders of the entire settings tree

### Known Limitations

- USB output is single-zone: the ambilight worker currently samples one pixel and sends a single RGB triplet per frame to the controller, which the companion firmware extends across the full strip. Per-edge position sampling driven by `LedCalibrationConfig` (edge counts, start anchor, direction, bottom gap) is planned for v1.4; the calibration UI still records and persists the full layout so the Hue channel path and future USB wiring stay consistent.
- The USB serial frame format is LumaSync-specific (`0xAA 0x55` header, LE LED count, gamma-corrected RGB, XOR checksum) — earlier documentation referred to this as "Adalight-compatible", which it is not.

## [1.2.0] — 2026-04-10

### Added

- Room map editor: undo/redo with Cmd+Z / Cmd+Shift+Z (max 50 steps)
- Room map editor: collapsible object list panel (right sidebar) with grouped objects and inline rename
- Room map editor: smart snap alignment guides (edge/center) during drag operations
- Room map editor: origin crosshair marker with snap-to-center
- Room map editor: right-click context menu (duplicate, delete, lock, z-order, rename, rotate)
- Room map editor: property bar with numeric x/y/w/h/rotation inputs for precise positioning
- Room map editor: extended keyboard shortcuts (Cmd+D duplicate, Shift+Arrow 10x nudge, L lock, [ ] z-order)
- Room map editor: scroll wheel zoom (0.5x–3x) with mouse-centered scaling and Cmd+0 fit-to-view
- Room map editor: space+drag and middle-mouse pan navigation
- Room map editor: real-time mouse coordinate display in meters
- Room map editor: template system with presets (TV 55", L-desk, full room, blank canvas)
- Room map editor: multi-image background layers with per-layer opacity, lock, and reorder
- Room map editor: universal object lock and resize handles for all object types
- Room map editor: floating left toolbar replacing fixed top toolbar

### Fixed

- Room map editor: rotated furniture resize now uses anchor-based positioning for correct behavior

## [1.1.1] — 2026-04-09

### Fixed

- Windows: calibration overlay close event no longer intercepted by the close-to-tray handler (overlay was preventing app quit)
- Windows: overlay positioning now uses display's scale factor instead of window's runtime scale factor, fixing placement on DPI-scaled monitors
- Windows: WebView2 child windows now receive `WS_EX_TRANSPARENT | WS_EX_LAYERED` so the overlay is truly click-through and does not block mouse events behind it

## [1.1.0] — 2026-04-09

### Added

- Ambilight: black border detection to crop letterbox bars before color sampling
- Ambilight: user-configurable color transition speed (smoothing alpha) in settings
- Tray: quick-action menu items (Lights Off, Resume Last Mode, Solid Color) with i18n label support
- CI: universal macOS binary (x86_64 + arm64) support in release workflow
- Debug: sidebar FPS widget in development builds

### Changed

- Hue: per-channel EWMA smoothing and continuous position sampling for smoother color transitions
- App version now resolved dynamically from the build instead of a hardcoded string
- macOS deployment target set to 12.3 for SCStream compatibility

### Fixed

- WS2812B output: apply gamma 2.2 correction for accurate perceived brightness
- Ambilight UI: reflect mode state correctly in UI on transient Hue failure
- Hue telemetry: fix stream state reporting after per-channel smoothing refactor
- Tests: fix 2 failing unit tests and resolve 12 unhandled rejections in App test suite
- SCStream: fix log timestamp formatting and release crash on session stop

## [1.0.4] — 2026-04-09

### Changed

- Migrated package manager from Yarn Classic (1.x) to pnpm 10; updated all scripts, CI/CD workflows, docs, and `tauri.conf.json`
- SECURITY.md: updated supported versions table from `0.1.x` to `1.0.x` and added private vulnerability reporting link
- README.md: added CI, Release, License, and Platform badges; added Platform Support table (macOS / Windows / Linux)
- CONTRIBUTING.md: commit examples updated with scope prefixes; added fork workflow and review process sections
- CODE_OF_CONDUCT.md: added GitHub private vulnerability reporting as a confidential report channel

### Fixed

- Release workflow (`release.yml`): added `typecheck`, `verify:shell-contracts`, and `vitest run` validation steps before build
- CI workflow (`ci.yml`): added `vitest run` step for frontend test coverage
- CHANGELOG.md: removed stale separator under `[Unreleased]`

### Added

- `.github/ISSUE_TEMPLATE/config.yml`: issue template chooser with security advisory link and blank issue restriction
- CLAUDE.md: added Code Style, Verification Flow sections; consolidated with AGENTS.md as single source of truth
- AGENTS.md: rewritten as thin reference to CLAUDE.md with agent-specific behavioral rules only

### Fixed (tests)

- `App.test.tsx`: fixed mode orchestration tests for updated output target and Hue gate behavior
- `manualConnectFlow.test.ts`: fixed auto-scan, stale selection, remembered port, and refresh throttle tests
- `useHueOnboarding.runtime.test.ts`: fixed retry pipeline routing test
- `GeneralSection.test.tsx`: fixed solid payload color change test
- `useRoomMapPersist.test.ts`: fixed resetConfig default room map test

---

## [1.0.3] — 2026-04-08

### Added

- Room map canvas editor with draggable furniture, TV anchor, and USB strip objects (`RoomMapEditor`, `RoomMapCanvas`, `RoomMapToolbar`)
- `HueChannelOverlay` renders channel positions on the room map using a `[-1,1]` normalized coordinate system
- `HueChannelMapPanel`: drag-and-drop single and multi-channel positioning, z-axis detail strip, coordinate tooltips, positions persisted via `shellStore`
- Zone auto-derivation: `deriveZones` algorithm maps LED strip positions to Hue channel regions automatically (13 unit tests)
- `ZoneDeriveOverlay` and `ZoneListPanel` for reviewing, renaming, and deleting derived zones; zone assignment mode in `HueChannelOverlay`
- `HueReadySummaryCard` in Device section — shows stream state indicator, entertainment area name, and bridge IP when Hue is connected
- `update_hue_channel_positions` Rust command writes edited channel positions back to the Hue bridge with save confirmation UI
- Target-aware lighting pipeline: `targets` field on `LightingModeConfig` selects which output devices (USB / Hue) participate per mode
- `resolveDefaultTargets` helper preserves backward compatibility with persisted configs that predate the targets field
- USB hot-plug detection: suggestion banner appears when a USB controller is plugged in while Hue-only mode is active
- Startup target filtering: USB target is silently removed from persisted state if the device is not connected on launch
- Delta start/stop in `handleOutputTargetsChange` — adding or removing an output target while a mode is active no longer restarts the full pipeline
- `HueTelemetryGrid` component in Diagnostics tab showing live DTLS stream metrics
- `HUE_FAULT_CODES` typed constant map replaces raw string matching for all DTLS fault conditions
- `FullTelemetrySnapshot` type and `get_full_telemetry_snapshot` Tauri command for combined runtime diagnostics
- `simulate_hue_fault` Rust command for fault injection during development and testing
- `copy_background_image` Rust command for importing a floor-plan background into the room map
- `roomMap.ts` contract: placement types, `RoomMapObject` discriminated union, coordinate definitions
- `UPDATE_CHANNEL_POSITIONS` command and associated status codes added to `hue.ts` contract
- `roomMap` persistence field and `ROOM_MAP` section ID added to `shell.ts` contract
- Shell contracts verifier extended to validate room map and Hue channel position contract coverage
- `targetFailed` i18n key under `device.hue` namespace (EN + TR)
- Tauri `dialog` and `fs` plugins for background image import

### Fixed

- `handleOutputTargetsChange` no longer stops an active lighting mode when a target is only being added (not removed)
- DTLS reconnect monitor correctly detects and registers thread death in all failure paths

---

### Historical — Pre-1.1.0 Foundation (2026-03-28)

#### Added

- Philips Hue DTLS 1.2 PSK entertainment streaming over UDP (cipher `PSK-AES128-GCM-SHA256`, port 2100) using vendored OpenSSL
- `ShutdownSignal` mechanism: DTLS sender thread signals clean exit; `stop_hue_stream` waits up to 3 s and marks timeout on failure
- DTLS thread death detection: `get_hue_stream_status` probes shutdown signal and registers a transient fault if the thread died silently while state was `Running`
- `HueSolidColorSnapshot` exposed in `get_hue_stream_status` response — tracks last pushed solid color for UI sync
- Hue → UI color sync: when Hue transitions to `Running`, the last solid color is reflected in the solid color picker exactly once per connection (no continuous polling)
- Stream running indicator on Hue output chip in Control page (pulsing emerald dot)
- Action-aware retry button in Device section — label changes based on `actionHint` (Re-pair, Revalidate, Retry…)
- Amber banner in Device section when pairing is waiting for the Hue bridge link button press (`HUE_PAIRING_PENDING_LINK_BUTTON`)
- "Stop retrying" button cancels an active Hue reconnect loop
- `✓ Saved` feedback toast (2 s) on Hue channel-to-region override save
- `SHELL_COMMANDS` constant map in `shell.ts` contract; `trayController.ts` migrated to use it
- Initial open-source contributor documentation (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`)
- MIT License

#### Changed

- `stop_with_timeout` now clears `persistent_sender` on user-initiated stops (`ModeControl`, `DeviceSurface`) and preserves it on system-triggered stops
- `start_hue_stream` guards against race condition: re-checks `owner.state` after async credential fetch before storing stream context
- `App.tsx` polls `get_hue_stream_status` every 5 s when Hue is active; removes "hue" from `activeOutputTargets` when backend reports `Failed` or `Idle`
- Device Settings redesign: Serial Device and Philips Hue split into separate cards with compact connect bar, status indicator dots, and per-port connection badges
- Control page output targets redesigned as compact chip-style toggles showing live device availability
- Hue stepper redesigned with numbered steps (✓ / active / inactive) and network unreachable hint
- Dark mode badge color improvements in Device section (Connected, Checking, Unreachable badges)
- Expanded `README.md` with setup, scripts, structure, and policy references

#### Fixed

- DTLS thread death no longer causes silent stuck-`Running` state — fault is registered and UI reflects failure
- Race condition in `start_hue_stream`: concurrent stop during async credential fetch no longer spawns a dangling sender
- `stop_hue_stream` timeout branch was unreachable (always called with `timed_out=false`) — now properly triggered via `ShutdownSignal`
- `persistent_sender` not cleared on user-initiated stop — fixed to prevent ghost connections
- Serial port handle leak on disconnect: `disconnect_session` now called on `LedPacketSender` to release the port
- Phantom `DISCONNECT_PORT` contract entry removed from `device.ts` (command never existed in Rust)
- CSP in `tauri.conf.json` changed from `null` to a strict policy
- Hue solid color not pushed on app startup when restoring a persisted solid mode
- `Cargo.toml` version aligned to `1.0.2` (was `0.1.0`), fixing auto-updater version detection
- `Cargo.toml` author placeholder replaced with real value

---

## [1.0.2] — 2026-03-26

### Fixed

- Release pipeline validation: aligned CI artifact naming and signature verification steps
- `reqwest` dependency upgraded to resolve upstream security advisory

---

## [1.0.1] — 2026-03-26

### Added

- Philips Hue entertainment area streaming (DTLS, CLIP v2)
- Hue channel-to-screen-region mapping with per-channel override UI
- Hue bridge discovery, pairing, and credential validation flow
- `get_hue_stream_status` runtime polling with fault-aware reconnect
- Hue solid color push via `set_hue_solid_color` command
- Output target selection (USB / Hue / both) persisted across sessions
- Display enumeration and overlay support for multi-monitor calibration
- DPI correction and fallback logic for display capture

### Changed

- Settings redesigned into Control / Calibration / Settings navigation
- Device section migrated to contract-first design (`device.ts`, `hue.ts`, `shell.ts`)
- Hue commands refactored to `async/await` for improved responsiveness

### Fixed

- CI: added `libudev` dependencies on Linux runners
- Calibration auto-open flag preserved across page refreshes via `sessionStorage`

---

## [1.0.0] — 2026-03-21

### Added

- Tray-first shell: single window hidden to tray on close, reopen via tray icon
- USB serial device discovery with CH340 / FTDI chip support
- Connection resilience: auto-reconnect loop with health check pipeline
- LED calibration editor: template selection, edge counts, gap, corner ownership, start anchor, direction
- Lighting modes: Off, Ambilight (screen capture), Solid (RGB + brightness)
- Ambilight: real-time screen capture at up to 60 Hz with runtime quality controller
- Solid: color picker and brightness slider with debounced 50 ms push
- Runtime telemetry: FPS, frame drops, capture errors displayed in Diagnostics tab
- EN / TR localization with automatic locale parity test
- Auto-updater: GitHub Releases with minisign signature verification
- Startup launch-at-login toggle
- QUAL-04 60-minute stability gate passed
