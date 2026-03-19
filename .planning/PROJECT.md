# Ambilight Desktop

## What This Is

Ambilight Desktop is a lightweight cross-platform desktop app that drives monitor backlight LEDs (WS2812B) based on live screen colors through USB-connected microcontrollers like Arduino. It targets a clean setup experience for makers and open-source users, while keeping runtime overhead low and behavior stable for long sessions. The app starts with Windows-first support and is designed to expand to additional platforms and advanced lighting modes over time.

## Core Value

Users can get smooth, stable, low-overhead Ambilight behavior on a USB-connected WS2812B setup with minimal setup friction.

## Requirements

### Validated

(None yet - ship to validate)

### Active

- [ ] User can connect to a USB serial LED controller through auto-detection with manual port fallback
- [ ] User can calibrate LED layout (start pixel, direction, edge counts, and gaps) with visual feedback
- [ ] User can run real-time Ambilight mode with soft color averaging that avoids harsh output
- [ ] User can use basic non-Ambilight lighting modes (for example solid color and basic presets)
- [ ] User can save and reuse lighting/calibration profiles
- [ ] User can complete guided setup via wizard and then manage detailed options in an advanced panel

### Out of Scope

- Wi-Fi or network-based device control (ESP/network transport) - defer until USB-first path is proven stable
- Cloud sync for profiles/settings - unnecessary for v1 local-first workflow
- Mobile app clients - desktop-first focus for initial release
- Advanced visual effect editor (timeline/node-based) - high complexity, defer to later milestone
- Preset marketplace/plugin ecosystem - defer until core reliability and UX are validated

## Context

The initial audience is the creator and a small early tester group, but the project is intended to be public open source from day one. The user wants technical guidance because some stack choices are still uncertain, and expects research-backed decisions before locking architecture and implementation details. Existing open-source Ambilight projects should be used as references for design and technical patterns, but implementation should remain original and license-compliant.

Hardware model for v1 is USB serial to Arduino-like controllers driving addressable WS2812B strips. Setup must support practical monitor geometry concerns (edge counts, start index, bottom/corner gaps) and provide fast-start templates plus deeper manual fallback. Reliability is a hard expectation: no crashes, graceful recovery from disconnects, and stable behavior during at least 1-hour continuous use.

## Constraints

- **Platform**: Windows first - reduce capture/driver complexity for v1
- **Transport**: USB serial only in v1 - broad compatibility with Arduino-like boards
- **Hardware**: WS2812B addressable LEDs - primary supported strip family for v1
- **Performance**: Balanced profile - smooth user experience with low system impact over absolute max throughput
- **Stability**: No crash tolerance - app and firmware workflow must not destabilize user system
- **Product Shape**: Tray app + full settings window - background operation with on-demand deep control
- **Open Source**: MIT license target - low-friction adoption and contribution

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prioritize smooth Ambilight in v1 | Core product promise and highest user value | - Pending |
| Launch on Windows first | Lower platform risk for capture + USB path | - Pending |
| Use USB serial transport for device communication | Simplest reliable path for Arduino-like hardware | - Pending |
| Include setup wizard plus advanced control panel | Supports both quick start and power users | - Pending |
| Include basic non-Ambilight modes and profile save in v1 | Expands day-to-day utility beyond screen mirroring | - Pending |
| Use open-source projects as reference, implement original code | Preserve learning benefits while staying license-safe | - Pending |

---
*Last updated: 2026-03-19 after initialization*
