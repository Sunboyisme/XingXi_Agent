//! Short/held Right Alt and explicit, read-only selection capture.
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::{
    core::w,
    Win32::{
        Foundation::*,
        System::{Com::*, LibraryLoader::GetModuleHandleW, Threading::*},
        UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};
static INPUT: OnceLock<mpsc::SyncSender<(u32, bool)>> = OnceLock::new();
static DOM: Mutex<Option<(u32, String)>> = Mutex::new(None);
static VERSION: AtomicU64 = AtomicU64::new(0);
pub fn cursor() -> (i32, i32) {
    unsafe {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        (p.x, p.y)
    }
}
pub fn offer_dom(_app: &tauri::AppHandle, text: String) {
    *DOM.lock().unwrap() = Some((std::process::id(), text));
}

pub fn parse_shortcut(value: &str) -> Result<(u32, u16), String> {
    let mut modifiers = 0;
    let mut key = 0;
    for token in value.split('+').map(|v| v.trim().to_uppercase()) {
        match token.as_str() {
            "CTRL" | "CONTROL" => modifiers |= 1,
            "SHIFT" => modifiers |= 2,
            "ALT" => modifiers |= 4,
            "WIN" | "META" => modifiers |= 8,
            _ => {
                if key != 0 {
                    return Err("快捷键只能包含一个普通按键".into());
                }
                key = if token.len() == 1 && token.as_bytes()[0].is_ascii_alphanumeric() {
                    token.as_bytes()[0] as u16
                } else if let Some(n) = token
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u16>().ok())
                    .filter(|n| (1..=12).contains(n))
                {
                    VK_F1.0 + n - 1
                } else {
                    return Err("请使用 Ctrl、Shift、Alt、Win 与字母、数字或 F1–F12 组合".into());
                };
            }
        }
    }
    if modifiers == 0 || key == 0 {
        return Err("划词快捷键需要修饰键和普通按键".into());
    }
    Ok((modifiers, key))
}
fn pressed(key: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(key.0 as i32) < 0 }
}
fn modifiers() -> u32 {
    u32::from(pressed(VK_CONTROL))
        | u32::from(pressed(VK_SHIFT)) * 2
        | u32::from(pressed(VK_MENU)) * 4
        | u32::from(pressed(VK_LWIN) || pressed(VK_RWIN)) * 8
}
unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let e = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if e.flags.0 & LLKHF_INJECTED.0 == 0 {
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if let Some(tx) = INPUT.get() {
                let _ = tx.try_send((e.vkCode, down));
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::sync_channel(256);
    let _ = INPUT.set(tx);
    std::thread::spawn(move || unsafe {
        let Ok(lock) = CreateMutexW(None, false, w!("Local\\XiaoXiDesktopAssistant")) else {
            return;
        };
        let mut owned = false;
        let mut keyboard = None;
        let mut alt: Option<Instant> = None;
        let mut voice = false;
        let mut chord = false;
        let mut last_pet = Instant::now();
        let mut down_keys = std::collections::HashSet::new();
        let java = std::sync::Arc::new(crate::java_selection::JavaSelection::new());
        loop {
            let p = app
                .state::<crate::desktop::Desktop>()
                .prefs
                .lock()
                .unwrap()
                .clone();
            if !owned && p.enabled {
                let acquired = WaitForSingleObject(lock, 0);
                if acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED {
                    owned = true;
                    keyboard = SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(hook),
                        GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0)),
                        0,
                    )
                    .ok();
                    if keyboard.is_none() {
                        owned = false;
                        let _ = ReleaseMutex(lock);
                    }
                    app.state::<crate::desktop::Desktop>()
                        .owned
                        .store(keyboard.is_some(), Ordering::Relaxed);
                    if p.pet && keyboard.is_some() {
                        if let Some(w) = app.get_webview_window("pet") {
                            let _ = w.show();
                        }
                    }
                }
            }
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            while let Ok((key, down)) = rx.try_recv() {
                if down {
                    if !down_keys.insert(key) {
                        continue;
                    }
                } else {
                    down_keys.remove(&key);
                }
                if !p.enabled {
                    continue;
                }
                if key == VK_RMENU.0 as u32 {
                    if down {
                        if alt.is_none() {
                            alt = Some(Instant::now());
                            chord = (8..255).any(|key| {
                                key != VK_RMENU.0 as i32
                                    && key != VK_MENU.0 as i32
                                    && GetAsyncKeyState(key) < 0
                            });
                            voice = false;
                        }
                    } else if let Some(start) = alt.take() {
                        if !chord {
                            if voice {
                                let _ = app.emit_to("quick", "desktop-release", ());
                            } else if start.elapsed() < Duration::from_millis(300) {
                                let a = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    if let Err(error) =
                                        crate::desktop::desktop_open(a.clone(), true)
                                    {
                                        let _ = a.emit_to("quick", "desktop-error", error);
                                        let _ = crate::desktop::desktop_open(a, false);
                                    }
                                });
                            }
                        }
                        voice = false;
                    }
                } else if down {
                    if alt.is_some() {
                        chord = true;
                        if voice {
                            crate::voice::voice_cancel(app.state(), None);
                            let _ = app.emit_to("quick", "desktop-voice-cancel", ());
                            voice = false;
                        }
                    }
                    if p.selection {
                        if let Ok((mods, k)) = parse_shortcut(&p.shortcut) {
                            if key == k as u32 && modifiers() == mods {
                                let generation = VERSION.fetch_add(1, Ordering::SeqCst) + 1;
                                let target = GetForegroundWindow();
                                let mut pid = 0;
                                GetWindowThreadProcessId(target, Some(&mut pid));
                                let local = DOM
                                    .lock()
                                    .unwrap()
                                    .as_ref()
                                    .filter(|(owner, _)| *owner == pid)
                                    .map(|(_, text)| text.clone())
                                    .filter(|s| !s.trim().is_empty());
                                let target_address = target.0 as isize;
                                let a = app.clone();
                                let j = java.clone();
                                std::thread::spawn(move || {
                                    let text = local
                                        .or_else(|| selected_text(pid))
                                        .or_else(|| j.selected(target_address));
                                    if VERSION.load(Ordering::SeqCst) != generation
                                        || GetForegroundWindow().0 as isize != target_address
                                    {
                                        return;
                                    }
                                    let error = if text.is_none() {
                                        Some("无法读取选中文字。请确认应用支持无障碍取词，且已选中文字。".into())
                                    } else {
                                        None
                                    };
                                    let b = a.clone();
                                    let _ = a.run_on_main_thread(move || {
                                        crate::desktop::offer_selection(
                                            &b,
                                            text.unwrap_or_default(),
                                            error,
                                        )
                                    });
                                });
                            }
                        }
                    }
                }
            }
            if alt.is_some_and(|t| t.elapsed() >= Duration::from_millis(300)) && !chord && !voice {
                voice = true;
                let a = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = crate::desktop::desktop_open(a.clone(), false);
                    let _ = a.emit_to("quick", "desktop-record", ());
                });
            }
            if last_pet.elapsed() > Duration::from_millis(50) {
                last_pet = Instant::now();
                if let Some(w) = app.get_webview_window("quick") {
                    if let (Ok(pos), Ok(size), Ok(scale)) =
                        (w.outer_position(), w.outer_size(), w.scale_factor())
                    {
                        let (x, y) = cursor();
                        let local_x = (x - pos.x) as f64 / scale;
                        let local_y = (y - pos.y) as f64 / scale;
                        let top = app
                            .state::<crate::desktop::Desktop>()
                            .quick_top
                            .load(Ordering::Relaxed) as f64;
                        let _ = w.set_ignore_cursor_events(
                            local_y < top
                                || local_x < 8.0
                                || local_x > size.width as f64 / scale - 8.0,
                        );
                    }
                }
                if p.pet && owned {
                    let (x, y) = cursor();
                    let _ = app.emit_to("pet", "desktop-cursor", serde_json::json!({"x":x,"y":y}));
                    if let Some(w) = app.get_webview_window("pet") {
                        if let (Ok(pos), Ok(size), Ok(scale)) =
                            (w.outer_position(), w.outer_size(), w.scale_factor())
                        {
                            let expanded = app
                                .state::<crate::desktop::Desktop>()
                                .pet_expanded
                                .load(Ordering::Relaxed);
                            let local_x = (x - pos.x) as f64 / scale;
                            let local_y = (y - pos.y) as f64 / scale;
                            let width = size.width as f64 / scale;
                            let height = size.height as f64 / scale;
                            let avatar = local_x >= width - 94.0 && local_y >= height - 94.0;
                            let bubble = expanded && local_y >= height - 220.0;
                            let _ = w.set_ignore_cursor_events(!(avatar || bubble));
                        }
                    }
                }
            }
            let _ = &keyboard;
            std::thread::sleep(Duration::from_millis(8));
        }
    });
}
fn selected_text(pid: u32) -> Option<String> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if !initialized {
            return None;
        }
        let result = (|| {
            let a: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
            if let Ok(timed) = windows::core::Interface::cast::<IUIAutomation2>(&a) {
                let _ = timed.SetConnectionTimeout(500);
                let _ = timed.SetTransactionTimeout(500);
            }
            let mut element = a.GetFocusedElement().ok()?;
            let walker = a.ControlViewWalker().ok()?;
            for _ in 0..12 {
                if element.CurrentProcessId().ok() != Some(pid as i32)
                    || element
                        .CurrentIsPassword()
                        .map(|v| v.as_bool())
                        .unwrap_or(true)
                {
                    return None;
                }
                if let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                {
                    if let Ok(ranges) = pattern.GetSelection() {
                        let mut parts = vec![];
                        for n in 0..ranges.Length().ok()?.min(32) {
                            if let Ok(text) = ranges.GetElement(n).and_then(|r| r.GetText(20001)) {
                                parts.push(text.to_string());
                            }
                        }
                        let text = parts.join("\n");
                        if !text.trim().is_empty() {
                            return Some(text);
                        }
                    }
                }
                element = walker.GetParentElement(&element).ok()?;
            }
            None
        })();
        CoUninitialize();
        result
    }
}
