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

Both items below are tracked, dismissed in Dependabot as `not_used`, and expected to close automatically once the upstream Tauri 2.x ecosystem refreshes the affected dependency chains. They are documented here for transparency.

- **RUSTSEC-2026-0097 — `rand` 0.7.3 unsoundness with a custom logger calling `rand::rng()`** (low). The vulnerable version reaches LumaSync only as a build-time transitive dep through `tauri-utils → kuchikiki → selectors → phf_generator`. LumaSync neither customizes the logger nor invokes `rand::rng()` at runtime through this chain, so the vulnerable code path is unreachable in shipped binaries.
- **RUSTSEC-2024-0429 — `glib` 0.18.5 unsoundness in `Iterator` / `DoubleEndedIterator` impls for `glib::VariantStrIter`** (medium). Reaches LumaSync only on Linux through `tauri → tray-icon → libappindicator → gtk-rs 0.18`. LumaSync never constructs nor iterates a `VariantStrIter` (directly or via any code path it owns), so the affected impls are not exercised. Will close once Tauri 2.x migrates to `gtk-rs` 0.19+ / `glib` 0.20 — tracked for the v1.6 milestone.
