//! Window bounds from the same desktop snapshot used by the capture editor.
use serde::Serialize;
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{HWND, LPARAM, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
        UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowRect, IsIconic, IsWindowVisible,
        },
    },
};

#[derive(Serialize)]
pub struct WindowRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

struct Snapshot {
    bounds: RECT,
    windows: Vec<WindowRect>,
}

unsafe extern "system" fn collect(window: HWND, parameter: LPARAM) -> BOOL {
    if !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
        return BOOL(1);
    }
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(window, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
    if cloaked != 0 {
        return BOOL(1);
    }
    let mut name = [0u16; 256];
    let length = GetClassNameW(window, &mut name) as usize;
    if matches!(
        String::from_utf16_lossy(&name[..length]).as_str(),
        "Progman" | "WorkerW"
    ) {
        return BOOL(1);
    }
    let mut frame = RECT::default();
    if DwmGetWindowAttribute(
        window,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        (&mut frame as *mut RECT).cast(),
        std::mem::size_of::<RECT>() as u32,
    )
    .is_err()
        && GetWindowRect(window, &mut frame).is_err()
    {
        return BOOL(1);
    }
    let snapshot = &mut *(parameter.0 as *mut Snapshot);
    let left = frame.left.max(snapshot.bounds.left);
    let top = frame.top.max(snapshot.bounds.top);
    let right = frame.right.min(snapshot.bounds.right);
    let bottom = frame.bottom.min(snapshot.bounds.bottom);
    if right - left >= 2 && bottom - top >= 2 {
        snapshot.windows.push(WindowRect {
            x: left - snapshot.bounds.left,
            y: top - snapshot.bounds.top,
            w: right - left,
            h: bottom - top,
        });
    }
    BOOL(1)
}

pub fn snapshot(x: i32, y: i32, width: i32, height: i32) -> Vec<WindowRect> {
    let mut snapshot = Snapshot {
        bounds: RECT {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
        },
        windows: vec![],
    };
    // EnumWindows preserves top-to-bottom order. Hit testing stays local to the
    // frozen image; pointer movement needs no IPC, UI Automation or clipboard.
    if unsafe {
        EnumWindows(
            Some(collect),
            LPARAM((&mut snapshot as *mut Snapshot) as isize),
        )
    }
    .is_err()
    {
        return vec![];
    }
    snapshot.windows
}
