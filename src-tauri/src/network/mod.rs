//! v1.5 W2-A3 — shared LAN-discovery primitives.
//!
//! Submodules:
//!
//! - `mdns` — process-wide mDNS-SD responder registry. Hue uses
//!   `_hue._tcp.local.` today; the shared instance pattern means the
//!   future WLED browser (`_wled._tcp.local.`) plugs in without
//!   spawning a second responder, avoiding macOS `SO_REUSEPORT`
//!   contention (D5 — locked).

pub mod mdns;
