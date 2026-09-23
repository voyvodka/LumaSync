//! The bridge-address guard. Dependency-free so the onboarding integration
//! harness (`tests/hue_onboarding_tdd.rs`) mounts the real check, not a stub.

use std::net::Ipv4Addr;
use std::str::FromStr;

/// The one check every Hue command applies to a bridge address from the
/// frontend: a bare IPv4 literal on a LAN — RFC 1918, link-local, or the
/// RFC 6598 shared space some overlay networks hand out. Anything else
/// (hostnames, ports, loopback, public, multicast, broadcast) is refused, so
/// the webview cannot point a request that carries the application key at an
/// arbitrary host.
pub(crate) fn validate_bridge_addr(value: &str) -> Result<Ipv4Addr, String> {
    let ip =
        Ipv4Addr::from_str(value).map_err(|_| format!("`{value}` is not a bare IPv4 address"))?;
    let [first, second, ..] = ip.octets();
    let shared_space = first == 100 && (64..=127).contains(&second);
    if ip.is_private() || ip.is_link_local() || shared_space {
        Ok(ip)
    } else {
        Err(format!("{ip} is not a local-network address"))
    }
}

pub(crate) fn is_valid_bridge_addr(value: &str) -> bool {
    validate_bridge_addr(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::is_valid_bridge_addr;

    #[test]
    fn only_a_bare_lan_ipv4_literal_is_a_bridge_address() {
        for ok in [
            "192.168.1.50",
            "10.0.0.2",
            "172.16.4.4",
            "172.31.255.1",
            "169.254.10.20",
            "100.64.0.9",
        ] {
            assert!(is_valid_bridge_addr(ok), "{ok}");
        }
        for bad in [
            "127.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.251",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "192.168.1.50:80",
            "127.0.0.1:443",
            " 192.168.1.50",
            "192.168.001.050",
            "2130706433",
            "0x7f.0.0.1",
            "localhost",
            "bridge.local",
            "::ffff:192.168.1.50",
            "fe80::1",
            "",
        ] {
            assert!(!is_valid_bridge_addr(bad), "{bad}");
        }
    }
}
