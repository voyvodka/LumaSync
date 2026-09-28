//! Tells the lighting when the user goes away and comes back: the computer
//! locks, sleeps or blanks its display, and later unlocks, wakes or lights it
//! again. Each is tracked on its own, so the lights go out on the first and
//! come back only once none is left. docs/architecture/lighting-transaction.md
//! ("Away").

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use log::{info, warn};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::lighting_mode::outputs::{prepare_away, AwayEdge};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Locked,
    DisplayOff,
    Asleep,
}

impl Reason {
    fn bit(self) -> u8 {
        match self {
            Self::Locked => 1,
            Self::DisplayOff => 2,
            Self::Asleep => 4,
        }
    }
}

/// How long going to sleep waits for the strip to go dark and the Hue stream
/// to stop: the system suspends soon after it tells us, and a strip keeps the
/// last frame it was sent through the whole sleep.
const SLEEP_GRACE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct AwayWatch {
    reasons: Mutex<u8>,
}

impl AwayWatch {
    /// The edge this report crosses, if any.
    fn note(&self, reason: Reason, active: bool) -> Option<AwayEdge> {
        let mut reasons = self
            .reasons
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let was_away = *reasons != 0;
        if active {
            *reasons |= reason.bit();
        } else {
            *reasons &= !reason.bit();
        }
        match (was_away, *reasons != 0) {
            (false, true) => Some(AwayEdge::Leave),
            (true, false) => Some(AwayEdge::Return),
            _ => None,
        }
    }
}

/// Called from the platform's notification, on whatever thread delivers it.
pub fn note<R: Runtime>(app: &AppHandle<R>, reason: Reason, active: bool) {
    let Some(watch) = app.try_state::<AwayWatch>() else {
        return;
    };
    let Some(edge) = watch.note(reason, active) else {
        return;
    };
    info!(
        "[away] {reason:?} {}: {edge:?}",
        if active { "on" } else { "off" }
    );
    // Prepared here, in the order the reports arrive; only the lights wait.
    let Some(turn) = prepare_away(app, edge) else {
        return;
    };
    let app = app.clone();
    let (done, wait) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = turn.run(&app).await {
            warn!("[away] {edge:?} failed: {error}");
        }
        let _ = done.send(());
    });
    // On macOS this holds the main thread, which delays the sleep itself —
    // the point — and any notification posted behind it; nothing the Off does
    // needs the main thread, so it cannot wait on itself.
    if reason == Reason::Asleep && active && wait.recv_timeout(SLEEP_GRACE).is_err() {
        warn!("[away] the lights were still going off when the system went to sleep");
    }
}

/// Starts listening. After `AwayWatch` and the lighting runtime are managed.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    platform::watch(app);
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
        NSWorkspaceScreensDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSString,
    };
    use tauri::{AppHandle, Runtime};

    use super::{note, Reason};

    fn observe<R: Runtime>(
        center: &NSNotificationCenter,
        name: &NSString,
        app: &AppHandle<R>,
        reason: Reason,
        active: bool,
    ) {
        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| note(&app, reason, active));
        // SAFETY: no object filter and no queue, so the block runs on the
        // posting thread (the main thread for both centres); it only clones an
        // `AppHandle`, which is Send.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        // The observers live as long as the app; nothing ever removes them.
        std::mem::forget(token);
    }

    pub fn watch<R: Runtime>(app: &AppHandle<R>) {
        let workspace = NSWorkspace::sharedWorkspace();
        let center = workspace.notificationCenter();
        // SAFETY: AppKit's notification-name constants, read once.
        let (will_sleep, did_wake, screens_sleep, screens_wake) = unsafe {
            (
                NSWorkspaceWillSleepNotification,
                NSWorkspaceDidWakeNotification,
                NSWorkspaceScreensDidSleepNotification,
                NSWorkspaceScreensDidWakeNotification,
            )
        };
        observe(&center, will_sleep, app, Reason::Asleep, true);
        observe(&center, did_wake, app, Reason::Asleep, false);
        observe(&center, screens_sleep, app, Reason::DisplayOff, true);
        observe(&center, screens_wake, app, Reason::DisplayOff, false);
        // The lock has no public NSWorkspace notification; the screen saver's
        // distributed pair is what every macOS app reads.
        let distributed = NSDistributedNotificationCenter::defaultCenter();
        let locked = NSString::from_str("com.apple.screenIsLocked");
        let unlocked = NSString::from_str("com.apple.screenIsUnlocked");
        observe(&distributed, &locked, app, Reason::Locked, true);
        observe(&distributed, &unlocked, app, Reason::Locked, false);
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::OnceLock;

    use log::warn;
    use tauri::{AppHandle, Runtime};
    use windows_sys::core::GUID;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Power::{
        RegisterPowerSettingNotification, POWERBROADCAST_SETTING,
    };
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND,
        PBT_POWERSETTINGCHANGE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
        WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };

    use super::Reason;

    type Report = Box<dyn Fn(Reason, bool) + Send + Sync>;

    /// The window procedure has no user data to carry the app in.
    static REPORT: OnceLock<Report> = OnceLock::new();

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn same_guid(a: &GUID, b: &GUID) -> bool {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let report = |reason, active| {
            if let Some(report) = REPORT.get() {
                report(reason, active);
            }
        };
        match message {
            WM_POWERBROADCAST => match wparam as u32 {
                PBT_APMSUSPEND => report(Reason::Asleep, true),
                PBT_APMRESUMEAUTOMATIC => report(Reason::Asleep, false),
                PBT_POWERSETTINGCHANGE if lparam != 0 => {
                    // SAFETY: for PBT_POWERSETTINGCHANGE, lParam points at a
                    // POWERBROADCAST_SETTING that lives for this call.
                    let setting = unsafe { &*(lparam as *const POWERBROADCAST_SETTING) };
                    if same_guid(&setting.PowerSetting, &GUID_CONSOLE_DISPLAY_STATE)
                        && setting.DataLength >= 1
                    {
                        // 0 off, 1 on, 2 dimmed: dimmed still counts as there.
                        report(Reason::DisplayOff, setting.Data[0] == 0);
                    }
                }
                _ => {}
            },
            WM_WTSSESSION_CHANGE => match wparam as u32 {
                WTS_SESSION_LOCK => report(Reason::Locked, true),
                WTS_SESSION_UNLOCK => report(Reason::Locked, false),
                _ => {}
            },
            _ => {}
        }
        // SAFETY: the default procedure for this window's own message.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    /// A hidden top-level window on its own thread: it receives the power
    /// broadcast, and registers for the display state and the session lock.
    pub fn watch<R: Runtime>(app: &AppHandle<R>) {
        let app = app.clone();
        let _ = REPORT.set(Box::new(move |reason, active| {
            super::note(&app, reason, active)
        }));
        let spawned = std::thread::Builder::new()
            .name("away-watch".into())
            .spawn(|| {
                let class = wide("LumaSyncAwayWatch");
                // SAFETY: plain Win32 window creation on this thread, which
                // then pumps its messages for the life of the process.
                unsafe {
                    let instance = GetModuleHandleW(std::ptr::null());
                    let mut wc: WNDCLASSW = std::mem::zeroed();
                    wc.lpfnWndProc = Some(window_proc);
                    wc.hInstance = instance;
                    wc.lpszClassName = class.as_ptr();
                    if RegisterClassW(&wc) == 0 {
                        warn!("[away] could not register the watch window class");
                        return;
                    }
                    let hwnd = CreateWindowExW(
                        0,
                        class.as_ptr(),
                        class.as_ptr(),
                        WS_OVERLAPPED,
                        0,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null(),
                    );
                    if hwnd.is_null() {
                        warn!("[away] could not create the watch window");
                        return;
                    }
                    if RegisterPowerSettingNotification(
                        hwnd,
                        &GUID_CONSOLE_DISPLAY_STATE,
                        DEVICE_NOTIFY_WINDOW_HANDLE,
                    ) == 0
                    {
                        warn!("[away] display on/off will not be heard");
                    }
                    if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                        warn!("[away] lock and unlock will not be heard");
                    }
                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            });
        if let Err(error) = spawned {
            warn!("[away] could not start the watch thread: {error}");
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use tauri::{AppHandle, Runtime};

    /// Not yet heard on Linux: logind's PrepareForSleep and session Lock
    /// signals are the way in. The lights stay as they are.
    pub fn watch<R: Runtime>(_app: &AppHandle<R>) {
        log::info!("[away] lock and sleep are not watched on this platform");
    }
}

#[cfg(test)]
mod tests {
    use super::{AwayWatch, Reason};
    use crate::commands::lighting_mode::outputs::AwayEdge;

    #[test]
    fn the_first_reason_leaves_and_the_last_one_returns() {
        let watch = AwayWatch::default();
        assert_eq!(watch.note(Reason::Locked, true), Some(AwayEdge::Leave));
        assert_eq!(watch.note(Reason::DisplayOff, true), None);
        assert_eq!(watch.note(Reason::Asleep, true), None);
        assert_eq!(watch.note(Reason::Asleep, false), None);
        assert_eq!(watch.note(Reason::DisplayOff, false), None);
        assert_eq!(watch.note(Reason::Locked, false), Some(AwayEdge::Return));
    }

    /// Waking to a lock screen is not coming back: the lights wait for the unlock.
    #[test]
    fn waking_to_a_lock_screen_keeps_the_lights_off() {
        let watch = AwayWatch::default();
        watch.note(Reason::Locked, true);
        watch.note(Reason::Asleep, true);
        assert_eq!(watch.note(Reason::Asleep, false), None);
        assert_eq!(watch.note(Reason::Locked, false), Some(AwayEdge::Return));
    }

    /// A repeated or unmatched report crosses no edge.
    #[test]
    fn a_repeat_or_a_stray_return_does_nothing() {
        let watch = AwayWatch::default();
        assert_eq!(watch.note(Reason::DisplayOff, false), None);
        assert_eq!(watch.note(Reason::DisplayOff, true), Some(AwayEdge::Leave));
        assert_eq!(watch.note(Reason::DisplayOff, true), None);
        assert_eq!(
            watch.note(Reason::DisplayOff, false),
            Some(AwayEdge::Return)
        );
    }
}
