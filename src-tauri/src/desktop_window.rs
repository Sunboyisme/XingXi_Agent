//! Keep Tauri's window state in sync while passive desktop updates avoid activation.
use std::{cell::Cell, sync::mpsc};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::WindowsAndMessaging::*,
};

thread_local! {
    static PASSIVE_WINDOW: Cell<isize> = const { Cell::new(0) };
}

unsafe extern "system" fn prevent_activation(code: i32, target: WPARAM, info: LPARAM) -> LRESULT {
    if code == HCBT_ACTIVATE as i32 || code == HCBT_SETFOCUS as i32 {
        let passive = PASSIVE_WINDOW.with(Cell::get);
        let hwnd = HWND(target.0 as *mut _);
        if passive != 0
            && (target.0 as isize == passive
                || unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as isize == passive)
        {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, target, info) }
}

struct ActivationGuard {
    hook: HHOOK,
    previous: isize,
}
impl Drop for ActivationGuard {
    fn drop(&mut self) {
        PASSIVE_WINDOW.with(|target| target.set(self.previous));
        unsafe {
            let _ = UnhookWindowsHookEx(self.hook);
        }
    }
}

fn without_activation(
    window: &tauri::WebviewWindow,
    update: impl FnOnce(&tauri::WebviewWindow) -> tauri::Result<()> + Send + 'static,
) -> Result<(), String> {
    let (reply, result) = mpsc::sync_channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let applied = (|| {
                let hwnd = target.hwnd().map_err(|error| error.to_string())?;
                // This hook exists only during this synchronous UI-thread update,
                // and vetoes activation of this window only. Later clicks and keys work normally.
                let hook = unsafe {
                    SetWindowsHookExW(WH_CBT, Some(prevent_activation), None, GetCurrentThreadId())
                }
                .map_err(|error| error.to_string())?;
                let _guard = ActivationGuard {
                    hook,
                    previous: PASSIVE_WINDOW.with(|value| value.replace(hwnd.0 as isize)),
                };
                update(&target).map_err(|error| error.to_string())
            })();
            let _ = reply.send(applied);
        })
        .map_err(|error| error.to_string())?;
    result.recv().map_err(|error| error.to_string())?
}

pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Direct ShowWindow leaves Tao's VISIBLE flag stale: hide becomes a no-op,
    // and cursor-style changes hide the window again. Always use Tauri here.
    without_activation(window, |window| window.show())
}

pub fn hide(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Wait for the UI thread so a following screenshot cannot capture this surface.
    without_activation(window, |window| window.hide())
}

pub fn ignore_cursor_events(window: &tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    without_activation(window, move |window| {
        window.set_ignore_cursor_events(ignore)
    })
}
