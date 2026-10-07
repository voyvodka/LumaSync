//! WLED switch-off — a user's Off on a WLED "usb" channel.

use super::*;

pub(crate) type WledPowerOff =
    dyn Fn(std::net::Ipv4Addr) -> Result<(), WledPowerOffError> + Send + Sync;

/// Managed only by tests; production switches the device off over HTTP.
pub(crate) struct WledPowerOffHandle(pub(crate) Arc<WledPowerOff>);

pub(super) fn wled_power_off_for<R: Runtime>(app: &AppHandle<R>) -> Arc<WledPowerOff> {
    if let Some(handle) = app.try_state::<WledPowerOffHandle>() {
        return Arc::clone(&handle.0);
    }
    // The production switch-off talks to a device on the network.
    if cfg!(test) {
        panic!("a test reached the production WLED switch-off — manage a WledPowerOffHandle");
    }
    Arc::new(power_off_wled)
}

/// Switches off a WLED device the "usb" channel stopped driving: a black frame alone lasts only
/// until the device leaves realtime mode and goes back to its own effect.
pub(crate) async fn power_off_left_wled<R: Runtime>(app: &AppHandle<R>, ip: std::net::Ipv4Addr) {
    let power_off = wled_power_off_for(app);
    let result = blocking(app, move |_| Ok(power_off(ip))).await;
    log_wled_power_off(ip, result);
}

pub(super) fn log_wled_power_off(
    ip: std::net::Ipv4Addr,
    result: Result<Result<(), WledPowerOffError>, String>,
) {
    match result {
        Ok(Ok(())) => info!("[lighting-off] WLED {ip} switched off"),
        Ok(Err(error)) => warn!("[lighting-off] WLED {ip} not switched off: {error:?}"),
        Err(error) => warn!("[lighting-off] WLED {ip} switch-off did not run: {error}"),
    }
}
