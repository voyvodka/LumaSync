use std::net::UdpSocket;
use std::time::Duration;

use super::config::SolidColorPayload;
use super::usb_output::SolidHold;
use crate::commands::led_output::ColorCorrectionConfig;
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

const TICK: Duration = Duration::from_millis(20);

fn receiver() -> (UdpSocket, WledSinkConfig) {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().unwrap(),
        port: socket.local_addr().unwrap().port(),
        led_count: 4,
        protocol: WledProtocol::Drgb,
    };
    (socket, config)
}

fn colour(r: u8, g: u8, b: u8) -> SolidColorPayload {
    SolidColorPayload {
        r,
        g,
        b,
        brightness: 1.0,
        kelvin: None,
    }
}

fn next(socket: &UdpSocket) -> Vec<u8> {
    let mut datagram = [0u8; 512];
    let (len, _) = socket.recv_from(&mut datagram).expect("a held frame");
    datagram[..len].to_vec()
}

#[test]
fn a_held_frame_repeats_until_the_hold_is_dropped() {
    let (socket, config) = receiver();
    let hold = SolidHold::start_every(
        &config,
        ColorCorrectionConfig::default(),
        4,
        &colour(255, 0, 0),
        TICK,
    )
    .unwrap();

    let first = next(&socket);
    assert_eq!(next(&socket), first);
    assert_eq!(next(&socket), first);

    drop(hold);
    while socket
        .set_read_timeout(Some(TICK * 5))
        .and_then(|()| socket.recv_from(&mut [0u8; 512]))
        .is_ok()
    {}
    assert!(
        socket.recv_from(&mut [0u8; 512]).is_err(),
        "a dropped hold must not send again"
    );
}

#[test]
fn a_published_colour_is_what_the_next_resend_carries() {
    let (socket, config) = receiver();
    let hold = SolidHold::start_every(
        &config,
        ColorCorrectionConfig::default(),
        4,
        &colour(255, 0, 0),
        TICK,
    )
    .unwrap();
    let red = next(&socket);

    hold.handle().publish(&colour(0, 0, 255));

    let blue = (0..10)
        .map(|_| next(&socket))
        .find(|frame| *frame != red)
        .expect("the published colour within a few ticks");
    assert_eq!(next(&socket), blue, "the new colour keeps being resent");
}
