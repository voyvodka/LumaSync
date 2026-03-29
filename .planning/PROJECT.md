# LumaSync

## What This Is

LumaSync, USB uzerinden baglanan WS2812B tabanli monitor arkasi LED sistemini canli ekran renkleriyle suren, tray-first masaustu uygulamasidir. v1.0 ile birlikte kurulum, kalibrasyon, temel modlar, runtime kalite kontrolu, telemetry gorunurlugu ve EN/TR dil destegi shipping seviyesine ulasmistir.

## Core Value

Users can get smooth, stable, low-overhead Ambilight behavior on a USB-connected WS2812B setup with minimal setup friction.

## Current State

- **Shipped version:** `v1.0` (2026-03-21)
- **Milestone scope:** Phase 1-8 tamamlandi
- **Release gate:** QUAL-04 (60 dakika stabilite) APPROVED
- **Archive refs:** `.planning/milestones/v1.0-ROADMAP.md`, `.planning/milestones/v1.0-REQUIREMENTS.md`
- **v1.1 progress:** Phase 01 complete (2026-03-29) — tray-first shell, startup toggle Rust-authoritative, all UAT gaps closed

## Requirements

### Validated

- ✓ User can connect to a USB serial LED controller through auto-detection with manual port fallback - v1.0
- ✓ User can calibrate LED layout (start pixel, direction, edge counts, and gaps) with visual feedback - v1.0
- ✓ User can run real-time Ambilight mode with soft color averaging that avoids harsh output - v1.0
- ✓ User can use basic non-Ambilight lighting modes (for example solid color and basic presets) - v1.0
- ✓ User can complete guided setup via wizard and then manage detailed options in an advanced panel - v1.0
- ✓ User can observe runtime quality via telemetry and use setup/mode flows in both English and Turkish - v1.0
- ✓ User can complete a 60-minute continuous run without crash or manual recovery - v1.0

### Active

- [ ] User can save and reuse lighting/calibration profiles
- [ ] User can use richer preset effects beyond solid color
- [ ] User can control multiple monitors/controllers with predictable orchestration

### Out of Scope

- Wi-Fi or network-based device control (ESP/network transport) - defer until USB-first path is proven stable
- Cloud sync for profiles/settings - unnecessary for local-first workflow
- Mobile app clients - desktop-first focus
- Advanced visual effect editor (timeline/node-based) - high complexity, defer to later milestone
- Preset marketplace/plugin ecosystem - defer until reliability and UX stay stable across next milestone

## Current Milestone: v1.1 Hue Entertainment Integration

**Goal:** Philips Hue Entertainment Bridge/Area entegrasyonunu mevcut USB-first runtime ile uyumlu sekilde ekleyip, kullanicinin Hue cihazlarini guvenilir sekilde Ambilight akisina dahil etmesini saglamak.

**Target features:**
- Hue bridge pairing + owner/credential yonetimi + area secimi
- Hue Entertainment DTLS stream baslat/durdur + keep-alive + state restore davranisi
- Device UI ve runtime orchestration katmanlarinda Hue path'in USB path ile birlikte guvenilir yonetimi

## Next Milestone Goals

1. Hue bridge entegrasyonu: pairing, entertainment area secimi, owner kontrolu.
2. Streaming guvenilirligi: DTLS send loop, keep-alive/retry, run stop/start state restore.
3. Entegrasyon disiplini: `src-tauri/src/commands`, device contracts/client/controller ve DeviceSection uzerinden tek akisli UX.

## Constraints

- **Platform**: Windows first
- **Transport**: USB serial first
- **Hardware**: WS2812B addressable LEDs
- **Performance**: Balanced profile (smoothness + low system impact)
- **Stability**: No crash tolerance in release gates
- **Product Shape**: Tray app + full settings window
- **Open Source**: MIT license target

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Prioritize smooth Ambilight in v1 | Core product promise and highest user value | Implemented in v1.0 |
| Launch on Windows first | Lower platform risk for capture + USB path | Implemented in v1.0 |
| Use USB serial transport for device communication | Simplest reliable path for Arduino-like hardware | Implemented in v1.0 |
| Include setup wizard plus advanced control panel | Supports both quick start and power users | Implemented in v1.0 |
| Include basic non-Ambilight modes and profile save in v1 | Expands day-to-day utility beyond screen mirroring | Partially implemented (modes yes, profiles deferred) |
| Hue Entertainment integration should follow production-grade references (Hyperion/HyperHDR) while keeping original implementation | Reduce protocol/streaming risk with proven patterns, preserve license-safe code ownership | Active for v1.1 |
| Runtime telemetry is pull-based and exposed as Rust-owned snapshots | Deterministic read path for UI observability with low coupling to worker lifecycle | Implemented in v1.0 |
| EN/TR parity is enforced with deterministic key-set tests and base-language normalization | Prevent i18n drift and avoid redundant writes on regional locale tags | Implemented in v1.0 |
| Use open-source projects as reference, implement original code | Preserve learning benefits while staying license-safe | Implemented in v1.0 |

---
*Last updated: 2026-03-29 after Phase 01 completion*
