// macOS-only window tweaks applied at startup — forbids native fullscreen
// rather than fighting its title-bar-stacking race. See
// docs/architecture/ui-and-shell.md.

use std::collections::HashMap;
use std::ffi::CString;
use std::sync::{LazyLock, Mutex, OnceLock};

use objc2::encode::Encode;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{ffi, msg_send, sel, ClassType};
use objc2_app_kit::{NSAnimationContext, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::NSRect;
use tauri::WebviewWindow;

pub fn forbid_native_fullscreen(window: &WebviewWindow) {
    let raw = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable: {err}");
            return;
        }
    };

    if raw.is_null() {
        return;
    }

    // SAFETY: Tauri returns a retained NSWindow pointer for the main window.
    // We borrow it for the duration of this call only and never store it.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");

        // Disable ⌃⌘F and the Window menu item. The green button then zooms instead of entering
        // fullscreen, and stays enabled: tao answers `is_maximizable` from it, and a disabled one
        // made the title bar's double-click do nothing.
        ns_window.setCollectionBehavior(NSWindowCollectionBehavior::FullScreenNone);
    }
}

/// The frame each window had before it zoomed, keyed by the NSWindow's address: the hook sits on
/// tao's delegate class, so every tao window passes through it.
static PRE_ZOOM: Mutex<Option<HashMap<usize, NSRect>>> = Mutex::new(None);

type ShouldZoom = extern "C-unwind" fn(&AnyObject, Sel, &NSWindow, NSRect) -> Bool;

/// Keeps the native zoom animation but lets the page draw during it. `zoom:` animates in a
/// run-loop mode that blocks the main thread, so WKWebView cannot commit a frame until it ends:
/// the page sat at its old size and the status bar and right-hand controls jumped into place at
/// the end (tauri-apps/tauri#13898). The delegate declines that zoom and runs the same frame change
/// through the window's animator, on the normal run loop, with AppKit's own zoom duration.
pub fn animate_zoom_on_run_loop(window: &WebviewWindow) {
    let raw = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable for zoom: {err}");
            return;
        }
    };
    if raw.is_null() {
        return;
    }

    // SAFETY: Tauri returns a retained NSWindow pointer; it is borrowed for this call only. The
    // method added matches `windowShouldZoom:toFrame:` exactly (BOOL, self, _cmd, NSWindow*,
    // NSRect), and tao's delegate does not implement it, so nothing it relies on is replaced.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");
        let Some(delegate) = ns_window.delegate() else {
            log::warn!("[macos_window] window has no delegate; zoom stays native");
            return;
        };
        let class: *const AnyClass = msg_send![&*delegate, class];
        let types = CString::new(format!(
            "{}{}{}{}{}",
            Bool::ENCODING,
            <*mut AnyObject>::ENCODING,
            Sel::ENCODING,
            <*mut AnyObject>::ENCODING,
            NSRect::ENCODING
        ))
        .expect("an encoding has no NUL");
        let imp = std::mem::transmute::<ShouldZoom, Imp>(should_zoom);
        // The runtime keeps the pointer; the string lives for the process.
        let added = ffi::class_addMethod(
            class.cast_mut(),
            sel!(windowShouldZoom:toFrame:),
            imp,
            types.into_raw(),
        );
        // The delegate class is shared by every window tao makes, so after the first window this
        // is normally our own method already in place — not a sign the zoom stayed native.
        if !added.as_bool() {
            log::debug!("[macos_window] delegate class already answers windowShouldZoom:toFrame:; left as is");
        }
    }
}

extern "C-unwind" fn should_zoom(
    _this: &AnyObject,
    _cmd: Sel,
    window: &NSWindow,
    proposed: NSRect,
) -> Bool {
    let key = window as *const NSWindow as usize;
    let target = {
        let mut guard = PRE_ZOOM
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let frames = guard.get_or_insert_with(HashMap::new);
        if window.isZoomed() {
            frames.remove(&key).unwrap_or(proposed)
        } else {
            frames.insert(key, window.frame());
            proposed
        }
    };
    NSAnimationContext::beginGrouping();
    NSAnimationContext::currentContext().setDuration(window.animationResizeTime(target));
    // SAFETY: `animator` is NSWindow's animation proxy (NSAnimatablePropertyContainer); it answers
    // every NSWindow message and is retained for the duration of this call.
    let animator: Retained<NSWindow> = unsafe { msg_send![window, animator] };
    animator.setFrame_display(target, true);
    NSAnimationContext::endGrouping();
    Bool::NO
}

/// Elevate an overlay / popup window so it floats over a macOS fullscreen
/// Space. The LED-twin overlay and the control popup must remain visible even
/// when another app owns the active fullscreen Space (e.g. a fullscreen game /
/// video the user is calibrating against). Sets `canJoinAllSpaces |
/// fullScreenAuxiliary` collection behaviour plus a raised window level, using
/// the same objc2 NSWindow pattern as `forbid_native_fullscreen`, and lets the
/// window into another app's full-screen Space (`ALLOWED_IN_OTHER_APPS_FULL_SCREEN`).
pub fn elevate_overlay_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let raw = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable for elevate: {err}");
            return;
        }
    };

    if raw.is_null() {
        return;
    }

    // SAFETY: Tauri returns a retained NSWindow pointer; we borrow it for the
    // duration of this call only and never store it.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");

        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );

        // NSStatusWindowLevel (25): above normal/floating windows so the
        // overlay + control popup stay visible over fullscreen content.
        let level: objc2_app_kit::NSWindowLevel = 25;
        ns_window.setLevel(level);

        if *ALLOWED_IN_OTHER_APPS_FULL_SCREEN {
            // The mark is only looked for, never messaged, so it is assigned rather than retained.
            ffi::objc_setAssociatedObject(
                &*ns_window as *const NSWindow as *mut AnyObject,
                joins_full_screen_key(),
                NSWindow::class() as *const AnyClass as *mut AnyObject,
                ffi::OBJC_ASSOCIATION_ASSIGN,
            );
        }
    }
}

type AllowedInFullScreen = extern "C-unwind" fn(&AnyObject, Sel, usize) -> Bool;

static JOINS_FULL_SCREEN: u8 = 0;

fn joins_full_screen_key() -> *const std::ffi::c_void {
    &JOINS_FULL_SCREEN as *const u8 as *const std::ffi::c_void
}

/// NSWindow's own answer, for every window not marked by `elevate_overlay_window`.
static NSWINDOW_ALLOWED_IN_FULL_SCREEN: OnceLock<AllowedInFullScreen> = OnceLock::new();

/// AppKit lets a `fullScreenAuxiliary` window into another app's full-screen
/// Space only when the private `_allowedInOtherAppsFullScreenSpaceWithCollectionBehavior:`
/// says so, and it says so only for a non-activating NSPanel: an NSWindow stays
/// on the Space it was first shown on. tao's TaoWindow answers it here instead —
/// yes for a marked window, NSWindow's answer for the rest. Turning the window
/// into a panel by swapping its class is not an option: AppKit removes an
/// observer registered under the old class in `-[NSWindow dealloc]`, which
/// throws. Without the query (a later macOS) the windows stay on their Space.
static ALLOWED_IN_OTHER_APPS_FULL_SCREEN: LazyLock<bool> = LazyLock::new(|| {
    let sel = sel!(_allowedInOtherAppsFullScreenSpaceWithCollectionBehavior:);
    let Some(tao) = AnyClass::get(c"TaoWindow") else {
        log::warn!("[macos_window] no TaoWindow class; preview windows stay on their Space");
        return false;
    };
    // SAFETY: NSWindow's method is read, not changed; the one added to
    // TaoWindow takes and returns what it does, under its type encoding.
    unsafe {
        let method = ffi::class_getInstanceMethod(NSWindow::class(), sel);
        let Some(original) = (!method.is_null())
            .then(|| ffi::method_getImplementation(method))
            .flatten()
        else {
            log::warn!("[macos_window] NSWindow no longer answers {sel}; preview windows stay on their Space");
            return false;
        };
        NSWINDOW_ALLOWED_IN_FULL_SCREEN
            .get_or_init(|| std::mem::transmute::<Imp, AllowedInFullScreen>(original));
        let imp =
            std::mem::transmute::<AllowedInFullScreen, Imp>(allowed_in_other_apps_full_screen);
        let added = ffi::class_addMethod(
            (tao as *const AnyClass).cast_mut(),
            sel,
            imp,
            ffi::method_getTypeEncoding(method),
        );
        if !added.as_bool() {
            log::warn!("[macos_window] TaoWindow already answers {sel}; preview windows stay on their Space");
        }
        added.as_bool()
    }
});

extern "C-unwind" fn allowed_in_other_apps_full_screen(
    this: &AnyObject,
    cmd: Sel,
    behavior: usize,
) -> Bool {
    // SAFETY: only the presence of the mark is read.
    let marked = unsafe { !ffi::objc_getAssociatedObject(this, joins_full_screen_key()).is_null() };
    if marked {
        return Bool::YES;
    }
    match NSWINDOW_ALLOWED_IN_FULL_SCREEN.get() {
        Some(original) => original(this, cmd, behavior),
        None => Bool::NO,
    }
}

/// The window server's number for the window (`CGWindowID`).
pub fn window_number<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<u32> {
    let raw = window.ns_window().ok().filter(|raw| !raw.is_null())?;
    // SAFETY: Tauri's retained NSWindow pointer, borrowed for this call only.
    let number = unsafe { (*(raw as *const NSWindow)).windowNumber() };
    u32::try_from(number).ok().filter(|&number| number > 0)
}

/// The app in front, when it is not this one.
pub fn frontmost_other_app() -> Option<i32> {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
        .filter(|pid| *pid != std::process::id() as i32)
}

pub fn activate_app(pid: i32) {
    if let Some(app) =
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
    {
        app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::empty());
    }
}

/// Shows the window on its own Space without making it key or activating the
/// app, so the user is not moved to that Space.
pub fn order_front_without_focus<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let raw = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        Ok(_) => return,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable for order_front: {err}");
            return;
        }
    };
    // SAFETY: as in `elevate_overlay_window` — a retained NSWindow, borrowed
    // for this call only.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");
        ns_window.orderFront(None);
    }
}

/// Brings the window forward while the app is not active, which `orderFront`
/// does not.
pub fn order_front_regardless<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let raw = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        Ok(_) => return,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable for order_front_regardless: {err}");
            return;
        }
    };
    // SAFETY: as in `elevate_overlay_window` — a retained NSWindow, borrowed
    // for this call only.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");
        ns_window.orderFrontRegardless();
    }
}

#[cfg(all(debug_assertions, not(feature = "e2e")))]
pub use dev_focus::{hand_focus_back_after_launch, note_front_app_before_launch};

#[cfg(all(debug_assertions, not(feature = "e2e")))]
mod dev_focus {
    use std::sync::Mutex;

    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

    /// The app that was in front when a dev build started. tao activates the app it launches, ignoring
    /// whatever the developer was using, and every Rust edit relaunches it; a debug build hands focus
    /// back instead. Release builds keep the normal launch: a user who opens the app wants it in front.
    static FRONT_BEFORE_LAUNCH: Mutex<Option<i32>> = Mutex::new(None);

    /// Before the event loop starts, while the developer's app is still in front.
    pub fn note_front_app_before_launch() {
        let pid = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
            .filter(|pid| *pid != std::process::id() as i32);
        *FRONT_BEFORE_LAUNCH
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = pid;
    }

    /// On the main window's first focus: gives it back to the app noted at launch, once.
    pub fn hand_focus_back_after_launch() {
        let pid = FRONT_BEFORE_LAUNCH
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(app) =
            pid.and_then(NSRunningApplication::runningApplicationWithProcessIdentifier)
        {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
}
