# Security Policy

## Supported Versions

Security updates are provided for the latest stable release.

| Version | Supported |
| --- | --- |
| 1.5.x (current: 1.5.1) | Yes |
| 1.4.x | No |
| < 1.4.0 | No |

## Reporting a Vulnerability

Please do not open public issues for potential security vulnerabilities.

Instead:

1. Use [GitHub's private vulnerability reporting](https://github.com/voyvodka/lumasync/security/advisories/new) if available.
2. Alternatively, share details privately with maintainers via email or a direct message.
3. Include reproduction steps, impact, and affected versions.
4. If possible, include a minimal proof of concept.

Suggested report template:

- Title: short summary of the issue
- Affected area: frontend, Tauri command, shell contract, or dependency
- Impact: what an attacker can do
- Reproduction: exact steps and environment
- Proposed mitigation: optional

## Response Expectations

- Initial acknowledgement target: within 72 hours
- Triage and severity assessment: as soon as possible
- Fix timeline: depends on severity and release readiness

## Disclosure Process

- Vulnerabilities are fixed privately first.
- Public disclosure is coordinated after a patch is available.
- If needed, release notes will include impact and upgrade guidance.

## Known Upstream Advisories

Items below are tracked and documented for transparency. Where the runtime path was reachable, the underlying dependency has been bumped; where the path is build-only or unreachable, the alert is dismissed in Dependabot as `not_used` and is expected to close automatically once the upstream Tauri 2.x ecosystem refreshes the affected dependency chains.

- **RUSTSEC-2026-0097 — `rand` unsoundness with a custom logger calling `rand::rng()`** (low). LumaSync depends on `rand` along three independent paths and treats them separately:
  - `rand` **0.8.x** (runtime, via `tauri-plugin-notification`) and `rand` **0.9.x** (runtime, via `xcap`) were **bumped to 0.8.6 and 0.9.4 respectively in v1.5.1**, clearing the runtime exposure.
  - `rand` **0.7.3** (build-only, via `tauri-utils → kuchikiki → selectors → phf_generator`) remains in the build graph but is unreachable from any shipped binary; LumaSync neither customizes the logger nor invokes `rand::rng()` along this chain, so the alert is dismissed `not_used` until the upstream ecosystem refreshes `phf` minor versions.
- **RUSTSEC-2024-0429 — `glib` 0.18.5 unsoundness in `Iterator` / `DoubleEndedIterator` impls for `glib::VariantStrIter`** (medium). Reaches LumaSync only on Linux through `tauri → tray-icon → libappindicator → gtk-rs 0.18`. LumaSync never constructs nor iterates a `VariantStrIter` (directly or via any code path it owns), so the affected impls are not exercised. Dismissed `not_used`; will close once Tauri 2.x migrates to `gtk-rs` 0.19+ / `glib` 0.20 — tracked for the v1.6 milestone.
