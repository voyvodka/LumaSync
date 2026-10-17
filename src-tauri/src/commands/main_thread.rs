//! Window builds handed to the main thread from an async command: on Windows a
//! webview built from a sync command never finishes (Tauri documents the
//! deadlock on `WebviewWindowBuilder::build`). An open posted here is one
//! main-thread step no close lands inside; a close sent before it reached the
//! main thread runs first, so a caller that closes waits for its open.

use tauri::{AppHandle, Runtime};

/// `f` on the main thread, awaited. `Err` says why it never ran.
pub(crate) async fn on_main<R, T, F>(app: &AppHandle<R>, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> T + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(f(&handle));
    })
    .map_err(|error| format!("the main thread did not take the window build: {error}"))?;
    receiver
        .await
        .map_err(|error| format!("the window build did not answer: {error}"))
}
