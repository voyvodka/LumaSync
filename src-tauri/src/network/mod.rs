//! Shared LAN-discovery primitives.
//!
//! Submodules:
//!
//! - `mdns` — process-wide mDNS-SD responder registry. Hue
//!   (`_hue._tcp.local.`) and WLED (`_wled._tcp.local.`) browse through
//!   the one shared instance rather than each spawning a responder,
//!   avoiding macOS `SO_REUSEPORT` contention.

pub mod mdns;
