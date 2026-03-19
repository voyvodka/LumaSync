# Feature Research

**Domain:** Desktop Ambilight software for PC backlight LEDs
**Researched:** 2026-03-19
**Confidence:** MEDIUM

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real-time screen mirroring to LEDs | Core promise of Ambilight products (Hue Sync desktop app, SignalRGB screen mirroring, Hyperion/Prismatik) | MEDIUM | Needs low-latency capture + edge sampling + serial frame pipeline |
| Reliable device connection and recovery | Users expect app to find controller, reconnect after unplug, and not require restarts | MEDIUM | Auto-detect serial + manual port fallback + heartbeat/retry logic |
| LED layout calibration (start LED, direction, edge counts, gaps) | Physical monitor layouts differ, so mapping must be configurable | HIGH | Wizard + visual preview is expected by maker/open-source audience |
| Color smoothing and safety controls | Raw capture flickers; users expect stable, comfortable output | MEDIUM | Temporal smoothing, gamma/brightness limits, optional per-channel correction |
| Profiles and quick mode switching | Common in Prismatik and SignalRGB ecosystem; users switch between work/game/movie setups | MEDIUM | Save/load profile bundles (layout + color + mode + device settings) |
| Basic non-screen modes (solid/effect/music reactive) | Competing desktop apps expose at least basic static/effect modes | MEDIUM | Keep simple in v1: solid color + a few presets; advanced editor deferred |
| Tray-first background operation with start-on-boot | Desktop lighting tools are expected to run in background | LOW | Tray controls: on/off, mode, profile, open settings |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Guided setup that validates both mapping and transport health | Reduces maker setup friction and support burden; faster first success | HIGH | Combine calibration wizard + serial throughput check + test pattern verification |
| Performance telemetry and adaptive quality | Lets users balance smoothness vs CPU/serial limits without guesswork | HIGH | Show capture FPS vs send FPS (similar to Luciferin producer/consumer framing) |
| Auto content heuristics (black-bar/aspect handling) | Better visual quality for movies and ultrawide content | HIGH | Dynamically ignore letterbox bars to avoid washed edge colors |
| Multi-monitor and multi-controller orchestration | Power-user value; strong differentiator after single-monitor stability | HIGH | Model as separate instances with optional sync policy |
| Local automation/API hooks (no cloud dependency) | Appeals to open-source and Home Assistant style workflows | MEDIUM | Local API/events for profile switching and mode control |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Cloud accounts and profile sync in v1 | Sounds convenient across devices | Adds auth/privacy/compliance complexity and weakens local-first value | Keep local profile export/import JSON |
| Network transport support in first milestone (Wi-Fi/UDP/MQTT) | Users want wireless flexibility | Expands failure surface and debugging matrix before USB path is stable | Ship USB serial first, add network in later milestone |
| Advanced timeline/node effect editor early | Looks like a strong differentiator | Very high UX + engine complexity; delays core reliability | Start with curated presets + parameter sliders |
| Plugin marketplace/ecosystem in early product | Community extensibility sounds attractive | Requires governance/versioning/security model too early | Provide stable local API first, evaluate plugins after adoption |

## Feature Dependencies

```
Reliable device connection
    └──requires──> Serial protocol framing + retry strategy

Real-time screen mirroring
    └──requires──> Reliable device connection
    └──requires──> LED layout calibration
    └──requires──> Color smoothing

Profiles and quick switching
    └──requires──> Real-time mirroring + non-screen modes + calibration persistence

Guided setup wizard
    └──enhances──> LED layout calibration
    └──enhances──> Reliable device connection

Multi-monitor orchestration
    └──requires──> Stable single-monitor pipeline + per-instance profile model

Network transport in v1
    └──conflicts──> USB-first stability goal
```

### Dependency Notes

- **Real-time mirroring requires reliable connection:** capture quality is irrelevant if serial output stalls or drops frames.
- **Real-time mirroring requires calibration:** wrong geometry breaks the core user perception even when FPS is high.
- **Profiles require persistent calibration and mode state:** otherwise profile switching becomes partial and confusing.
- **Guided setup enhances connection and calibration:** best point to catch wrong COM port, LED order, or strip direction errors.
- **Multi-monitor requires stable single-monitor first:** without deterministic timing on one pipeline, orchestration multiplies failures.
- **Network transport conflicts with USB-first v1:** both in scope at once will slow reliability validation.

## MVP Definition

### Launch With (v1)

Minimum viable product - what is needed to validate the concept.

- [ ] Real-time screen mirroring with soft color averaging - core value promise
- [ ] USB serial auto-detect + manual fallback + reconnect handling - reliability baseline
- [ ] LED layout calibration wizard with visual feedback - required for correct output
- [ ] Basic non-screen modes (solid + a few presets) - everyday utility beyond mirroring
- [ ] Profiles (save/load) and tray controls - practical daily workflow

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] Performance telemetry panel (capture/send FPS, queue health) - add when support feedback indicates tuning need
- [ ] Multi-monitor single-controller and dual-controller modes - add after single-monitor stability metrics are met
- [ ] Auto black-bar/aspect handling - add after baseline color mapping is stable

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] Local API + automation integrations (Home Assistant style workflows) - after config model stabilizes
- [ ] Network transport (WLED/UDP/MQTT) - after USB-first reliability and support burden are acceptable
- [ ] Advanced effect editor and community plugin model - only after strong core retention

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Real-time screen mirroring | HIGH | MEDIUM | P1 |
| USB detection/recovery | HIGH | MEDIUM | P1 |
| LED layout calibration wizard | HIGH | HIGH | P1 |
| Color smoothing and limits | HIGH | MEDIUM | P1 |
| Profiles + tray controls | HIGH | MEDIUM | P1 |
| Basic non-screen modes | MEDIUM | MEDIUM | P1 |
| Performance telemetry | MEDIUM | HIGH | P2 |
| Auto aspect-ratio handling | MEDIUM | HIGH | P2 |
| Multi-monitor orchestration | MEDIUM | HIGH | P2 |
| Local automation/API hooks | MEDIUM | MEDIUM | P3 |
| Network transport support | MEDIUM | HIGH | P3 |
| Advanced effect editor | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Competitor A | Competitor B | Our Approach |
|---------|--------------|--------------|--------------|
| Desktop screen sync | Philips Hue Sync desktop app pairs PC screen content with Hue lights | SignalRGB includes screen mirroring in Free plan | Match baseline with lower setup friction for WS2812B USB makers |
| Multi-device ecosystem | Hyperion supports broad hardware integrations and web config | Prismatik supports Lightpack/Adalight and profile-based control | Start narrow (USB serial + WS2812B), then expand adapters |
| Advanced controls | SignalRGB differentiates with macros/game integrations/fan control in Pro | Govee Desktop adds DreamView modes and Razer Chroma Connect | Differentiate on reliability tooling and setup correctness before ecosystem breadth |

## Sources

- Philips Hue Apps page (includes Hue Sync desktop app): https://www.philips-hue.com/en-us/explore-hue/apps (official, accessed 2026-03-19, MEDIUM)
- Philips Hue Entertainment page (sync positioning and compatibility framing): https://www.philips-hue.com/en-us/explore-hue/propositions/entertainment (official, accessed 2026-03-19, MEDIUM)
- SignalRGB Support home (free/pro capability split incl. screen mirroring): https://docs.signalrgb.com/ (official docs, accessed 2026-03-19, MEDIUM)
- SignalRGB product site (ecosystem positioning: effects, integrations, macros, visualizers): https://signalrgb.com (official, accessed 2026-03-19, LOW-MEDIUM)
- Hyperion documentation (web UI config model, broad capture/device support): https://docs.hyperion-project.org/ (official docs, accessed 2026-03-19, HIGH)
- Prismatik/Lightpack README (feature set: ambilight, visualizer, profiles, API, multi-device notes): https://github.com/psieg/Lightpack (official repo README, accessed 2026-03-19, MEDIUM)
- Govee Desktop page (desktop core features: DreamView, music sync, Razer Chroma Connect): https://desktop.govee.com (official, accessed 2026-03-19, MEDIUM)
- Firefly Luciferin README (performance framing, smoothing, multi-monitor, aspect-ratio switching): https://github.com/sblantipodi/firefly_luciferin (official repo README, accessed 2026-03-19, MEDIUM)

---
*Feature research for: Desktop Ambilight software ecosystem*
*Researched: 2026-03-19*
