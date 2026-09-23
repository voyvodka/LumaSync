//! The one orderly shutdown every trigger converges on: tray Quit, Ctrl+C in
//! dev, Cmd+Q (`RunEvent::Exit`), a programmatic exit or restart
//! (`RunEvent::ExitRequested`), and the Windows update installer. See
//! docs/architecture/ui-and-shell.md.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::commands::device_connection::ActiveSinkRegistry;
use crate::commands::hue::commands::stop_hue_stream_before_exit;
use crate::commands::hue::state_store::HueRuntimeStateStore;
use crate::commands::launch::AUTOSTART_TRAY_ARG;
use crate::commands::lighting_mode::stop_lighting_blocking;

/// Hard-exit deadline for shutdown. The cleanup path joins worker threads,
/// drops SCStream, deactivates DTLS — each of which can theoretically hang
/// (objc cleanup, network timeout, mutex contention). The watchdog ensures
/// the process always dies within this window, even when something hangs.
const SHUTDOWN_WATCHDOG: Duration = Duration::from_secs(4);

/// Step 1 (lighting worker) is abandoned after this long.
const SHUTDOWN_LIGHTING_DEADLINE: Duration = Duration::from_millis(1_500);

/// Step 2 (Hue) must be finished this long after cleanup starts. Step 1 is
/// bounded to 1.5 s, so the Hue step always gets at least ~1.8 s, and the
/// remaining ~0.6 s under the watchdog is left for step 3 and the exit.
const SHUTDOWN_HUE_DEADLINE: Duration = Duration::from_millis(3_300);

/// How long past its own deadline step 2 is waited on before being abandoned.
const SHUTDOWN_HUE_GRACE: Duration = Duration::from_millis(100);

/// What asked for the shutdown; only ever logged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShutdownTrigger {
    TrayQuit,
    // The Ctrl+C hook is dev-only and unix-only.
    #[cfg_attr(not(all(unix, debug_assertions)), allow(dead_code))]
    Sigint,
    ExitRequested,
    RestartRequested,
    AppExit,
    UpdateInstaller,
}

impl ShutdownTrigger {
    fn label(self) -> &'static str {
        match self {
            Self::TrayQuit => "tray-quit",
            Self::Sigint => "sigint",
            Self::ExitRequested => "exit-requested",
            Self::RestartRequested => "restart-requested",
            Self::AppExit => "app-exit",
            Self::UpdateInstaller => "update-installer",
        }
    }
}

/// Per-step bounds of `run_cleanup`. A value rather than constants so the
/// deadline behaviour can be tested without waiting out the real ones.
pub(crate) struct CleanupBudget {
    pub lighting: Duration,
    pub hue_deadline: Duration,
    pub hue_grace: Duration,
}

const PRODUCTION_BUDGET: CleanupBudget = CleanupBudget {
    lighting: SHUTDOWN_LIGHTING_DEADLINE,
    hue_deadline: SHUTDOWN_HUE_DEADLINE,
    hue_grace: SHUTDOWN_HUE_GRACE,
};

/// The three cleanup steps, injected so the sequencing is testable.
pub(crate) struct CleanupSteps {
    pub stop_lighting: Box<dyn FnOnce() -> Result<(), String> + Send>,
    pub stop_hue: Box<dyn FnOnce(Instant) -> String + Send>,
    pub clear_sink: Box<dyn FnOnce() + Send>,
}

fn app_cleanup_steps<R: Runtime>(app: &AppHandle<R>) -> CleanupSteps {
    let lighting_app = app.clone();
    let hue_app = app.clone();
    let sink_app = app.clone();
    CleanupSteps {
        stop_lighting: Box::new(move || stop_lighting_blocking(&lighting_app).map(|_| ())),
        stop_hue: Box::new(move |deadline| {
            stop_hue_stream_before_exit(&hue_app.state::<HueRuntimeStateStore>(), deadline)
                .status
                .code
        }),
        clear_sink: Box::new(move || sink_app.state::<ActiveSinkRegistry>().clear()),
    }
}

// ---------------------------------------------------------------------------
// run_cleanup — actually stops all background workers.
//
// Runs on a dedicated std::thread (NEVER the macOS main thread). Joins
// the ambilight worker (drops SCStream from a non-main thread, see
// LightingWorkerRuntime::stop), waits up to 3s for the Hue DTLS sender
// to ack shutdown, and releases the active serial sink.
// ---------------------------------------------------------------------------
pub(crate) fn run_cleanup(steps: CleanupSteps, budget: &CleanupBudget) {
    log::info!("[shutdown] cleanup thread started");
    let cleanup_started = Instant::now();

    // 1. Ambilight / serial capture worker — bounded to 1.5s on shutdown.
    //
    // stop_lighting locks runtime_state.runtime, then apply_mode_change ->
    // stop_previous -> worker.stop() -> handle.join(). Worst case is ~1.6s when
    // the lock is held behind an in-flight set_lighting_mode warmup or a Solid
    // write waiting on a wedged port (OUTPUT_TIMEOUT_MS=500); the worker itself
    // no longer waits on the port, its writer thread does. With
    // no inner deadline this could starve step 2 (Hue deactivate) under the 4s
    // watchdog, leaving the bridge in entertainment mode ("phantom active
    // streamer"). So detach the call and abandon after 1.5s if it hasn't
    // returned. We BLOCK on recv_timeout here (not fire-and-forget) so step 2
    // only begins once step 1 returns or is abandoned, preserving the
    // sequential ordering. process::exit(0) below reaps the orphan thread even
    // if it is still wedged mid-join holding runtime.lock() -- we do not join it.
    let t1 = Instant::now();
    let stop_lighting = steps.stop_lighting;
    let (tx1, rx1) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("lumasync-shutdown-lighting".into())
        .spawn(move || {
            let _ = tx1.send(stop_lighting());
        })
        .ok();
    match rx1.recv_timeout(budget.lighting) {
        Ok(Ok(())) => {
            log::info!("[shutdown] step 1 (stop_lighting) took {:?}", t1.elapsed())
        }
        Ok(Err(e)) => log::warn!("[shutdown] stop_lighting reported: {e}"),
        Err(_) => log::warn!(
            "[shutdown] step 1 (stop_lighting) abandoned after {:?}",
            t1.elapsed()
        ),
    }

    // 2. Hue entertainment stream — deactivate, then put the area's lights back
    //    the way they were before the stream started (off stays off).
    //
    // stop_hue_stream's worst case is HTTP deactivate (5s reqwest timeout)
    // + sender shutdown wait (3s Condvar) + the light restore, which blows
    // through the 4s watchdog when the bridge is slow or unreachable. So the
    // quit path passes a deadline that every one of those waits honours, and
    // this thread still abandons the call shortly after it in case something
    // does not. Bridge state restore is best-effort (the bridge times out the
    // entertainment session server-side anyway); process::exit(0) below tears
    // down an orphaned worker regardless.
    let t2 = Instant::now();
    let hue_deadline = cleanup_started + budget.hue_deadline;
    let stop_hue = steps.stop_hue;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("lumasync-shutdown-hue".into())
        .spawn(move || {
            let _ = tx.send(stop_hue(hue_deadline));
        })
        .ok();
    let hue_wait = hue_deadline.saturating_duration_since(Instant::now()) + budget.hue_grace;
    match rx.recv_timeout(hue_wait) {
        Ok(code) => {
            log::info!(
                "[shutdown] step 2 (stop_hue_stream) took {:?} ({code})",
                t2.elapsed()
            )
        }
        Err(_) => log::warn!(
            "[shutdown] step 2 (stop_hue_stream) abandoned after {:?}",
            t2.elapsed()
        ),
    }

    // 3. Active LED sink (serial port session).
    let t3 = Instant::now();
    (steps.clear_sink)();
    log::info!("[shutdown] step 3 (sink clear) took {:?}", t3.elapsed());

    log::info!("[shutdown] cleanup complete, exiting");
}

/// How the process finally goes: `true` relaunches first. Never returns in
/// production; tests record the call instead.
type ExitAction = Arc<dyn Fn(bool) + Send + Sync>;

/// Idempotent shutdown state shared by every trigger. The first trigger wins;
/// exactly one caller gets to end the process.
pub(crate) struct ShutdownCoordinator {
    fired: AtomicBool,
    restart: AtomicBool,
    exit_claimed: AtomicBool,
    cleanup_done: Mutex<bool>,
    cleanup_done_changed: Condvar,
}

impl ShutdownCoordinator {
    pub(crate) const fn new() -> Self {
        Self {
            fired: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            exit_claimed: AtomicBool::new(false),
            cleanup_done: Mutex::new(false),
            cleanup_done_changed: Condvar::new(),
        }
    }

    fn try_begin(&self, restart: bool) -> bool {
        if self.fired.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.restart.store(restart, Ordering::SeqCst);
        true
    }

    fn restart_requested(&self) -> bool {
        self.restart.load(Ordering::SeqCst)
    }

    fn mark_cleanup_done(&self) {
        let mut done = self
            .cleanup_done
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *done = true;
        self.cleanup_done_changed.notify_all();
    }

    /// `true` once cleanup has finished, `false` if `timeout` ran out first.
    fn wait_for_cleanup(&self, timeout: Duration) -> bool {
        let done = self
            .cleanup_done
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (done, _) = self
            .cleanup_done_changed
            .wait_timeout_while(done, timeout, |done| !*done)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *done
    }

    /// Runs `exit` if no one else has; `false` means another thread owns the
    /// exit and is ending the process now.
    fn finish(&self, exit: &(dyn Fn(bool) + Send + Sync)) -> bool {
        if self.exit_claimed.swap(true, Ordering::SeqCst) {
            return false;
        }
        exit(self.restart_requested());
        true
    }

    /// Spawns the cleanup thread and the watchdog. `false` when an earlier
    /// trigger already started the shutdown.
    fn begin(
        &'static self,
        trigger: ShutdownTrigger,
        restart: bool,
        cleanup: Box<dyn FnOnce() + Send>,
        exit: ExitAction,
        watchdog: Duration,
    ) -> bool {
        if !self.try_begin(restart) {
            log::info!(
                "[shutdown] {} ignored — a shutdown is already in progress",
                trigger.label()
            );
            return false;
        }
        log::info!(
            "[shutdown] kicked off trigger={} restart={restart} (watchdog={watchdog:?})",
            trigger.label()
        );

        let cleanup_exit = Arc::clone(&exit);
        let spawned = std::thread::Builder::new()
            .name("lumasync-shutdown".into())
            .spawn(move || {
                cleanup();
                self.mark_cleanup_done();
                // A relaunch is left to whoever runs after `RunEvent::Exit`:
                // Tauri's plugins release the single-instance lock there, and a
                // new process spawned before that hands its launch to this one.
                if !self.restart_requested() {
                    self.finish(&*cleanup_exit);
                }
            });
        if let Err(error) = spawned {
            log::error!("[shutdown] could not spawn the cleanup thread ({error}) — exiting now");
            self.mark_cleanup_done();
            self.finish(&*exit);
            return true;
        }

        let watchdog_exit = Arc::clone(&exit);
        let spawned = std::thread::Builder::new()
            .name("lumasync-shutdown-watchdog".into())
            .spawn(move || {
                std::thread::sleep(watchdog);
                if !self.exit_claimed.load(Ordering::SeqCst) {
                    log::warn!("[shutdown] watchdog fired — forcing exit (cleanup hung)");
                }
                self.finish(&*watchdog_exit);
            });
        if let Err(error) = spawned {
            log::error!("[shutdown] could not spawn the shutdown watchdog: {error}");
        }
        true
    }

    /// The main thread's half of `RunEvent::Exit`: wait for cleanup, bounded by
    /// the watchdog, then end the process here. `false` means another thread
    /// owns the exit.
    fn hold_until_exit(&self, timeout: Duration, exit: &(dyn Fn(bool) + Send + Sync)) -> bool {
        log::info!("[shutdown] main thread holding exit until cleanup finishes");
        if !self.wait_for_cleanup(timeout) {
            log::warn!(
                "[shutdown] cleanup still running at the watchdog deadline — exiting anyway"
            );
        }
        self.finish(exit)
    }
}

static COORDINATOR: ShutdownCoordinator = ShutdownCoordinator::new();

/// Starts the orderly shutdown; later triggers are logged and ignored.
pub(crate) fn begin<R: Runtime>(app: &AppHandle<R>, trigger: ShutdownTrigger, restart: bool) {
    let cleanup_app = app.clone();
    let exit_app = app.clone();
    COORDINATOR.begin(
        trigger,
        restart,
        Box::new(move || run_cleanup(app_cleanup_steps(&cleanup_app), &PRODUCTION_BUDGET)),
        Arc::new(move |restart| exit_process(&exit_app, restart)),
        SHUTDOWN_WATCHDOG,
    );
}

/// `RunEvent::Exit`, on the main thread. Never returns into Tauri's teardown.
pub(crate) fn hold_main_thread_until_exit<R: Runtime>(app: &AppHandle<R>) -> ! {
    let exit_app = app.clone();
    COORDINATOR.hold_until_exit(SHUTDOWN_WATCHDOG, &move |restart| {
        exit_process(&exit_app, restart)
    });
    // Another thread won the exit and is ending the process right now.
    loop {
        std::thread::park();
    }
}

/// The updater's `on_before_exit` hook. On Windows the plugin launches the
/// installer and exits the process itself as soon as this returns, so the
/// cleanup runs inline, with its per-step bounds and no watchdog to race it.
pub(crate) fn cleanup_before_installer<R: Runtime>(app: &AppHandle<R>) {
    if !COORDINATOR.try_begin(false) {
        log::info!("[shutdown] update-installer ignored — a shutdown is already in progress");
        return;
    }
    log::info!(
        "[shutdown] kicked off trigger={} restart=false (inline)",
        ShutdownTrigger::UpdateInstaller.label()
    );
    run_cleanup(app_cleanup_steps(app), &PRODUCTION_BUDGET);
    COORDINATOR.mark_cleanup_done();
    // What the plugin's default hook did, which ours replaces.
    app.cleanup_before_exit();
}

/// Whether `RunEvent::ExitRequested` carries Tauri's restart code, which
/// `prevent_exit` cannot stop.
pub(crate) fn is_restart_code(code: Option<i32>) -> bool {
    code == Some(tauri::RESTART_EXIT_CODE)
}

fn exit_process<R: Runtime>(app: &AppHandle<R>, restart: bool) {
    cleanup_orphan_socket();
    if restart {
        let mut env = app.env();
        env.args_os = relaunch_args(env.args_os);
        log::info!("[shutdown] relaunching");
        tauri::process::restart(&env);
    }
    std::process::exit(0);
}

/// A relaunch is always one the user asked for from the window, so it must not
/// inherit autostart's start-hidden flag.
fn relaunch_args(args: Vec<OsString>) -> Vec<OsString> {
    let mut args = args.into_iter();
    args.next()
        .into_iter()
        .chain(args.filter(|arg| arg != AUTOSTART_TRAY_ARG))
        .collect()
}

// Hard-exit bypasses plugin destroy(), leaking the single-instance socket.
// See docs/architecture/ui-and-shell.md.
fn cleanup_orphan_socket() {
    let path = "/tmp/com_lumasync_app_si.sock";
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("[shutdown] removed orphan socket {path}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[shutdown] could not remove {path}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{
        is_restart_code, relaunch_args, run_cleanup, CleanupBudget, CleanupSteps,
        ShutdownCoordinator, ShutdownTrigger,
    };

    const MS: Duration = Duration::from_millis(1);

    fn coordinator() -> &'static ShutdownCoordinator {
        Box::leak(Box::new(ShutdownCoordinator::new()))
    }

    /// Every exit the coordinator performs: whether it relaunched, and whether
    /// cleanup had finished by then.
    #[derive(Clone, Default)]
    struct ExitLog {
        exits: Arc<Mutex<Vec<(bool, bool)>>>,
        cleanup_finished: Arc<AtomicBool>,
    }

    impl ExitLog {
        fn action(&self) -> Arc<dyn Fn(bool) + Send + Sync> {
            let log = self.clone();
            Arc::new(move |restart| {
                let finished = log.cleanup_finished.load(Ordering::SeqCst);
                log.exits.lock().unwrap().push((restart, finished));
            })
        }

        fn cleanup(&self, takes: Duration) -> Box<dyn FnOnce() + Send> {
            let finished = Arc::clone(&self.cleanup_finished);
            Box::new(move || {
                std::thread::sleep(takes);
                finished.store(true, Ordering::SeqCst);
            })
        }

        fn exits(&self) -> Vec<(bool, bool)> {
            self.exits.lock().unwrap().clone()
        }
    }

    #[test]
    fn a_quit_cleans_up_then_exits_exactly_once() {
        let log = ExitLog::default();
        let coordinator = coordinator();

        assert!(coordinator.begin(
            ShutdownTrigger::TrayQuit,
            false,
            log.cleanup(50 * MS),
            log.action(),
            300 * MS,
        ));
        std::thread::sleep(500 * MS);

        assert_eq!(
            log.exits(),
            vec![(false, true)],
            "the watchdog must not exit a second time"
        );
    }

    #[test]
    fn a_hung_cleanup_is_ended_by_the_watchdog() {
        let log = ExitLog::default();
        let coordinator = coordinator();

        coordinator.begin(
            ShutdownTrigger::TrayQuit,
            false,
            log.cleanup(5_000 * MS),
            log.action(),
            100 * MS,
        );
        std::thread::sleep(300 * MS);

        assert_eq!(log.exits(), vec![(false, false)]);
    }

    /// Cmd+Q: returning from `RunEvent::Exit` let AppKit end the process under
    /// the cleanup thread, so every step after the first was lost.
    #[test]
    fn the_main_thread_holds_the_exit_until_cleanup_has_finished() {
        let log = ExitLog::default();
        let coordinator = coordinator();
        let started = Instant::now();

        coordinator.begin(
            ShutdownTrigger::AppExit,
            false,
            log.cleanup(200 * MS),
            log.action(),
            2_000 * MS,
        );
        coordinator.hold_until_exit(2_000 * MS, &*log.action());

        assert!(
            started.elapsed() >= 200 * MS,
            "returned after {:?}",
            started.elapsed()
        );
        let exits = log.exits();
        assert_eq!(exits.len(), 1, "{exits:?}");
        assert_eq!(exits[0], (false, true), "exited before cleanup finished");
    }

    #[test]
    fn the_main_thread_gives_up_waiting_at_the_watchdog_deadline() {
        let log = ExitLog::default();
        let coordinator = coordinator();
        let started = Instant::now();

        coordinator.begin(
            ShutdownTrigger::AppExit,
            false,
            log.cleanup(5_000 * MS),
            log.action(),
            5_000 * MS,
        );
        assert!(coordinator.hold_until_exit(150 * MS, &*log.action()));

        assert!(started.elapsed() < 1_000 * MS);
        assert_eq!(log.exits(), vec![(false, false)]);
    }

    /// A relaunch before `RunEvent::Exit` would find the single-instance lock
    /// still held and hand its launch straight back to the dying process.
    #[test]
    fn a_restart_is_left_to_the_main_thread_after_exit() {
        let log = ExitLog::default();
        let coordinator = coordinator();

        coordinator.begin(
            ShutdownTrigger::RestartRequested,
            true,
            log.cleanup(20 * MS),
            log.action(),
            400 * MS,
        );
        std::thread::sleep(150 * MS);
        assert!(
            log.exits().is_empty(),
            "the cleanup thread relaunched on its own"
        );

        assert!(coordinator.hold_until_exit(1_000 * MS, &*log.action()));
        std::thread::sleep(500 * MS);
        assert_eq!(log.exits(), vec![(true, true)]);
    }

    #[test]
    fn the_first_trigger_wins() {
        let log = ExitLog::default();
        let coordinator = coordinator();

        assert!(coordinator.begin(
            ShutdownTrigger::RestartRequested,
            true,
            log.cleanup(20 * MS),
            log.action(),
            5_000 * MS,
        ));
        assert!(!coordinator.begin(
            ShutdownTrigger::AppExit,
            false,
            log.cleanup(Duration::ZERO),
            log.action(),
            5_000 * MS,
        ));
        assert!(coordinator.hold_until_exit(1_000 * MS, &*log.action()));
        assert_eq!(
            log.exits(),
            vec![(true, true)],
            "the later trigger dropped the restart"
        );
    }

    fn steps(
        lighting_takes: Duration,
        hue_takes: Duration,
        order: &Arc<Mutex<Vec<&'static str>>>,
        hue_deadline_seen: &Arc<Mutex<Option<Instant>>>,
    ) -> CleanupSteps {
        let lighting_order = Arc::clone(order);
        let hue_order = Arc::clone(order);
        let sink_order = Arc::clone(order);
        let deadline_seen = Arc::clone(hue_deadline_seen);
        CleanupSteps {
            stop_lighting: Box::new(move || {
                std::thread::sleep(lighting_takes);
                lighting_order.lock().unwrap().push("lighting");
                Ok(())
            }),
            stop_hue: Box::new(move |deadline| {
                *deadline_seen.lock().unwrap() = Some(deadline);
                hue_order.lock().unwrap().push("hue-start");
                std::thread::sleep(hue_takes);
                hue_order.lock().unwrap().push("hue-end");
                "HUE_STREAM_STOPPED".to_string()
            }),
            clear_sink: Box::new(move || sink_order.lock().unwrap().push("sink")),
        }
    }

    const TEST_BUDGET: CleanupBudget = CleanupBudget {
        lighting: Duration::from_millis(100),
        hue_deadline: Duration::from_millis(400),
        hue_grace: Duration::from_millis(50),
    };

    #[test]
    fn cleanup_runs_the_steps_in_order() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let deadline = Arc::new(Mutex::new(None));
        let started = Instant::now();

        run_cleanup(steps(10 * MS, 10 * MS, &order, &deadline), &TEST_BUDGET);

        assert_eq!(
            *order.lock().unwrap(),
            ["lighting", "hue-start", "hue-end", "sink"]
        );
        let deadline = deadline.lock().unwrap().expect("hue step never ran");
        assert!(deadline >= started + TEST_BUDGET.hue_deadline);
        assert!(deadline < Instant::now() + TEST_BUDGET.hue_deadline);
    }

    /// A lighting stop wedged behind a mode change must not eat the Hue step's
    /// time: the bridge would stay in entertainment mode.
    #[test]
    fn a_wedged_lighting_step_is_abandoned_and_hue_still_runs() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let deadline = Arc::new(Mutex::new(None));
        let started = Instant::now();

        run_cleanup(steps(5_000 * MS, 10 * MS, &order, &deadline), &TEST_BUDGET);

        assert!(started.elapsed() < 400 * MS, "took {:?}", started.elapsed());
        assert_eq!(*order.lock().unwrap(), ["hue-start", "hue-end", "sink"]);
    }

    #[test]
    fn a_wedged_hue_step_is_abandoned_at_its_deadline() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let deadline = Arc::new(Mutex::new(None));
        let started = Instant::now();

        run_cleanup(steps(10 * MS, 5_000 * MS, &order, &deadline), &TEST_BUDGET);

        let elapsed = started.elapsed();
        assert!(elapsed >= TEST_BUDGET.hue_deadline, "took {elapsed:?}");
        assert!(
            elapsed < TEST_BUDGET.hue_deadline + 300 * MS,
            "took {elapsed:?}"
        );
        assert_eq!(*order.lock().unwrap(), ["lighting", "hue-start", "sink"]);
    }

    #[test]
    fn only_tauris_restart_code_is_a_restart() {
        assert!(is_restart_code(Some(tauri::RESTART_EXIT_CODE)));
        assert!(!is_restart_code(Some(0)));
        assert!(!is_restart_code(None));
    }

    #[test]
    fn a_relaunch_drops_the_autostart_flag_and_keeps_the_rest() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            relaunch_args(args(&["/app/lumasync", "--tray", "--verbose"])),
            args(&["/app/lumasync", "--verbose"])
        );
        assert_eq!(relaunch_args(args(&["--tray"])), args(&["--tray"]));
        assert!(relaunch_args(Vec::new()).is_empty());
    }
}
