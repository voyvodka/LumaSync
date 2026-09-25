//! The lighting transaction's view of Hue. Production runs the same start and
//! stop the `start_hue_stream` / `stop_hue_stream` commands run, so the
//! `stop_in_flight` wait, the start's step-4c guard and `set_active_stream`
//! keep their meaning; a test swaps in a fake that publishes into a real
//! `HueOutputLive` and never reaches a bridge.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

use super::LightingRuntimeState;
use crate::commands::hue::area_cache::HueReadFreshness;
use crate::commands::hue::commands::{start_hue_stream_on, stop_hue_stream_on};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::state_store::{
    acquire_hue_runtime, HueOutputLive, HueRuntimeCommandResult, HueRuntimeState,
    HueRuntimeStateStore, HueRuntimeTriggerSource, StartHueStreamRequest,
};
use crate::commands::hue_onboarding::{
    check_hue_stream_readiness_with_freshness, ActiveStreamerView, ACTIVE_STREAMER_REASON,
};

pub(crate) type HueFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a readiness probe says about the area a boot restore was refused on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HueAreaVerdict {
    Free,
    /// Held by another session, and held is the only thing wrong with it.
    Busy,
    /// Anything that waiting does not clear: unreachable, re-pair, no channels.
    Other,
}

pub(crate) trait HueDriver: Send + Sync {
    fn start(&self, request: StartHueStreamRequest) -> HueFuture<'_, HueRuntimeCommandResult>;
    /// `lights` is what the area's lights get once the stream is down.
    fn stop(
        &self,
        trigger: HueRuntimeTriggerSource,
        lights: HueLightsAfterStop,
    ) -> HueFuture<'_, HueRuntimeCommandResult>;
    fn probe_area(&self, request: StartHueStreamRequest) -> HueFuture<'_, HueAreaVerdict>;
    /// Streaming, starting, retrying, or `Failed` with lights still to put back.
    fn runtime_active(&self) -> bool;
    /// The slot a running ambilight worker follows.
    fn output_live(&self) -> Arc<HueOutputLive>;
    /// The area the live stream holds, when one is live.
    fn live_area_id(&self) -> Option<String>;
}

/// Managed only by tests; production resolves to `ProductionHueDriver`.
pub(crate) struct HueDriverHandle(pub(crate) Arc<dyn HueDriver>);

pub(crate) fn hue_driver_for<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn HueDriver> {
    if let Some(handle) = app.try_state::<HueDriverHandle>() {
        return Arc::clone(&handle.0);
    }
    // The production driver talks to a bridge on the network.
    if cfg!(test) {
        panic!("a test reached the production Hue driver — manage a HueDriverHandle with a fake");
    }
    Arc::new(ProductionHueDriver { app: app.clone() })
}

/// The Hue output slot the running worker follows, from the same source the
/// transaction hands `apply_mode_change`.
pub(crate) fn hue_output_for<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<HueOutputLive>> {
    if let Some(handle) = app.try_state::<HueDriverHandle>() {
        return Some(handle.0.output_live());
    }
    app.try_state::<HueRuntimeStateStore>()
        .map(|store| store.output_live())
}

pub(crate) struct ProductionHueDriver<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> HueDriver for ProductionHueDriver<R> {
    fn start(&self, request: StartHueStreamRequest) -> HueFuture<'_, HueRuntimeCommandResult> {
        Box::pin(async move {
            let store = self.app.state::<HueRuntimeStateStore>();
            let lighting = self.app.state::<LightingRuntimeState>();
            start_hue_stream_on(store.inner(), request, &|| lighting.is_closing()).await
        })
    }

    fn stop(
        &self,
        trigger: HueRuntimeTriggerSource,
        lights: HueLightsAfterStop,
    ) -> HueFuture<'_, HueRuntimeCommandResult> {
        Box::pin(async move {
            let store = self.app.state::<HueRuntimeStateStore>();
            stop_hue_stream_on(store.inner(), trigger, lights).await
        })
    }

    fn probe_area(&self, request: StartHueStreamRequest) -> HueFuture<'_, HueAreaVerdict> {
        Box::pin(async move {
            let readiness = check_hue_stream_readiness_with_freshness(
                request.bridge_ip,
                request.username,
                request.area_id,
                HueReadFreshness::Cached,
                ActiveStreamerView::Foreign,
            )
            .await;
            area_verdict(
                &readiness.status.code,
                readiness.readiness.ready,
                &readiness.readiness.reasons,
            )
        })
    }

    fn runtime_active(&self) -> bool {
        let store = self.app.state::<HueRuntimeStateStore>();
        let owner = acquire_hue_runtime(&store.runtime);
        owner.state != HueRuntimeState::Idle
            || owner.active_stream.is_some()
            || owner.light_restore.is_some()
    }

    fn output_live(&self) -> Arc<HueOutputLive> {
        self.app.state::<HueRuntimeStateStore>().output_live()
    }

    fn live_area_id(&self) -> Option<String> {
        let store = self.app.state::<HueRuntimeStateStore>();
        let owner = acquire_hue_runtime(&store.runtime);
        owner
            .active_stream
            .as_ref()
            .map(|stream| stream.area_id.clone())
    }
}

/// `readHueAreaVerdict` in `bootHueRetry.ts`: busy only when the
/// active streamer is the *only* thing blocking the area, since one that also
/// has no channels would still refuse once the streamer lets go.
pub(crate) fn area_verdict(code: &str, ready: bool, reasons: &[String]) -> HueAreaVerdict {
    if code == "HUE_STREAM_READY" && ready {
        return HueAreaVerdict::Free;
    }
    if code == "HUE_STREAM_NOT_READY" && reasons.len() == 1 && reasons[0] == ACTIVE_STREAMER_REASON
    {
        return HueAreaVerdict::Busy;
    }
    HueAreaVerdict::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_means_the_streamer_is_the_only_blocker() {
        let streamer = vec![ACTIVE_STREAMER_REASON.to_string()];
        assert_eq!(
            area_verdict("HUE_STREAM_READY", true, &[]),
            HueAreaVerdict::Free
        );
        assert_eq!(
            area_verdict("HUE_STREAM_NOT_READY", false, &streamer),
            HueAreaVerdict::Busy
        );
        let also_empty = vec![
            ACTIVE_STREAMER_REASON.to_string(),
            "no channels".to_string(),
        ];
        assert_eq!(
            area_verdict("HUE_STREAM_NOT_READY", false, &also_empty),
            HueAreaVerdict::Other
        );
        assert_eq!(
            area_verdict("HUE_STREAM_READINESS_FAILED", false, &streamer),
            HueAreaVerdict::Other
        );
    }
}
