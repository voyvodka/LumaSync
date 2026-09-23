//! Routes panics into the log file. The default hook writes to stderr, which a
//! released Windows GUI process does not have, so a panic there left no trace.

use std::any::Any;
use std::panic::PanicHookInfo;

/// Installs the hook, chained to the one already in place.
pub fn install() {
    chain(|line| log::error!("{line}"));
}

fn chain<F>(sink: F)
where
    F: Fn(&str) + Send + Sync + 'static,
{
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        sink(&describe(info));
        previous(info);
    }));
}

fn describe(info: &PanicHookInfo<'_>) -> String {
    let thread = std::thread::current();
    let location = info
        .location()
        .map(|location| location.to_string())
        .unwrap_or_else(|| "<unknown location>".to_string());
    format!(
        "[panic] thread '{}' panicked at {location}: {}",
        thread.name().unwrap_or("<unnamed>"),
        payload_message(info.payload())
    )
}

fn payload_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(message) = payload.downcast_ref::<&str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message
    } else {
        "<non-string panic payload>"
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::chain;

    /// The panic hook is process-global and other tests may panic on purpose
    /// while this one has its hook installed; only this test's line is read.
    #[test]
    fn a_thread_panic_is_described_and_the_previous_hook_still_runs() {
        let original = std::panic::take_hook();
        let previous_calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&previous_calls);
        std::panic::set_hook(Box::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));

        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_lines = Arc::clone(&lines);
        chain(move |line| sink_lines.lock().unwrap().push(line.to_string()));

        let joined = std::thread::Builder::new()
            .name("panic-log-probe".into())
            .spawn(|| panic!("probe {} went wrong", 42))
            .unwrap()
            .join();

        let _ours = std::panic::take_hook();
        std::panic::set_hook(original);

        assert!(joined.is_err(), "the probe thread must have panicked");
        let lines = lines.lock().unwrap();
        let line = lines
            .iter()
            .find(|line| line.contains("panic-log-probe"))
            .unwrap_or_else(|| panic!("no line for the probe thread in {lines:?}"));
        assert!(line.starts_with("[panic] thread 'panic-log-probe' panicked at "));
        assert!(line.contains("panic_log.rs:"), "{line}");
        assert!(line.ends_with(": probe 42 went wrong"), "{line}");
        assert!(
            previous_calls.load(Ordering::SeqCst) >= 1,
            "the chained hook never ran"
        );
    }
}
