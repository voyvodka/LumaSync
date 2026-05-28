use std::net::Ipv4Addr;
use std::str::FromStr;

fn main() {
    let ip = Ipv4Addr::from_str("127.0.0.1").unwrap();
    println!("loopback: {}", ip.is_loopback());
    println!("unspecified: {}", ip.is_unspecified());
    println!("multicast: {}", ip.is_multicast());
    println!("broadcast: {}", ip.is_broadcast());
}
