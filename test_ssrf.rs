use std::net::Ipv4Addr;
use std::str::FromStr;

fn main() {
    let bridge_ip = "127.0.0.1";
    match Ipv4Addr::from_str(bridge_ip) {
        Ok(ip) if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() && !ip.is_broadcast() => {
            println!("Valid");
        }
        _ => {
            println!("Invalid");
        }
    }
}
