//! Desktop input ownership and the standalone Right Alt gesture.
use crate::desktop::Desktop;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::{
    core::w,
    Win32::{
        Foundation::*,
        System::{LibraryLoader::GetModuleHandleW, Threading::*},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};
struct KeyEvent {
    key: u32,
    down: bool,
    at: Instant,
    other_held: bool,
    capture: bool,
}
static INPUT: OnceLock<mpsc::SyncSender<KeyEvent>> = OnceLock::new();
static SCREENSHOT_ENABLED: AtomicBool = AtomicBool::new(false);
static CAPTURE_KEY: AtomicBool = AtomicBool::new(false);
static ALT_ENABLED: AtomicBool = AtomicBool::new(false);
static ALT_HELD: AtomicBool = AtomicBool::new(false);
static ALT_SUPPRESSED: AtomicBool = AtomicBool::new(false);
static GESTURE: AtomicU64 = AtomicU64::new(0);
static KEYBOARD_INPUT: AtomicU64 = AtomicU64::new(0);
pub fn keyboard_input_generation() -> u64 { KEYBOARD_INPUT.load(Ordering::SeqCst) }
pub fn cursor() -> (i32, i32) {
    unsafe {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        (p.x, p.y)
    }
}
pub fn gesture_held(gesture: u64) -> bool {
    ALT_HELD.load(Ordering::SeqCst) && GESTURE.load(Ordering::SeqCst) == gesture
}
fn pressed(key: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(key.0 as i32) < 0 }
}
unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let e = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if e.flags.0 & LLKHF_INJECTED.0 == 0 {
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if down && ![VK_MENU.0 as u32, VK_LMENU.0 as u32, VK_RMENU.0 as u32,
                VK_CONTROL.0 as u32, VK_LCONTROL.0 as u32, VK_RCONTROL.0 as u32,
                VK_SHIFT.0 as u32, VK_LSHIFT.0 as u32, VK_RSHIFT.0 as u32].contains(&e.vkCode) {
                KEYBOARD_INPUT.fetch_add(1, Ordering::SeqCst);
            }
            let other_held = if e.vkCode == VK_RMENU.0 as u32 && down {
                (8..255).any(|k| {
                    k != VK_MENU.0 as i32
                        && k != VK_RMENU.0 as i32
                        && unsafe { GetAsyncKeyState(k) } < 0
                })
            } else {
                false
            };
            let screenshot = down && e.vkCode == 0x45 && SCREENSHOT_ENABLED.load(Ordering::Relaxed)
                && pressed(VK_LMENU) && !pressed(VK_RMENU) && !pressed(VK_CONTROL) && !pressed(VK_SHIFT);
            let consume_capture = if e.vkCode == 0x45 {
                if screenshot { CAPTURE_KEY.store(true, Ordering::SeqCst); true }
                else if !down { CAPTURE_KEY.swap(false, Ordering::SeqCst) } else { false }
            } else { false };
            if screenshot {
                // Mask Alt's menu activation without changing the physical Alt gesture.
                let mask = [false, true].map(|up| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: VK_CONTROL, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() }
                }});
                let _ = unsafe { SendInput(&mask, std::mem::size_of::<INPUT>() as i32) };
            }
            let mut consume_alt = false;
            if e.vkCode == VK_RMENU.0 as u32 {
                if down {
                    if !ALT_HELD.swap(true, Ordering::SeqCst) {
                        GESTURE.fetch_add(1, Ordering::SeqCst);
                        ALT_SUPPRESSED.store(
                            ALT_ENABLED.load(Ordering::Relaxed) && !other_held,
                            Ordering::SeqCst,
                        );
                    }
                    consume_alt = ALT_SUPPRESSED.load(Ordering::SeqCst);
                } else {
                    ALT_HELD.store(false, Ordering::SeqCst);
                    consume_alt = ALT_SUPPRESSED.swap(false, Ordering::SeqCst);
                }
            }
            if let Some(tx) = INPUT.get() {
                let _ = tx.try_send(KeyEvent {
                    key: e.vkCode,
                    down,
                    at: Instant::now(),
                    other_held,
                    capture: screenshot,
                });
            }
            if consume_alt || consume_capture {
                return LRESULT(1);
            }
            if e.vkCode != VK_RMENU.0 as u32 && down && ALT_SUPPRESSED.swap(false, Ordering::SeqCst)
            {
                // Replay a chord in its original order, while a standalone Right Alt never activates an application's menu.
                let alt = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_RMENU,
                            dwFlags: KEYEVENTF_EXTENDEDKEY,
                            ..Default::default()
                        },
                    },
                };
                let key = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(e.vkCode as u16),
                            wScan: e.scanCode as u16,
                            dwFlags: if e.flags.0 & LLKHF_EXTENDED.0 != 0 {
                                KEYEVENTF_EXTENDEDKEY
                            } else {
                                KEYBD_EVENT_FLAGS(0)
                            },
                            ..Default::default()
                        },
                    },
                };
                if unsafe { SendInput(&[alt, key], std::mem::size_of::<INPUT>() as i32) } == 2 {
                    return LRESULT(1);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
fn publish(app: &tauri::AppHandle) {
    let _ = app.emit(
        "desktop-preferences",
        crate::desktop::desktop_preferences(app.clone()),
    );
}
fn pointer_surfaces(app: &tauri::AppHandle) {
    crate::pomodoro::pointer_update(app);
    let state = app.state::<Desktop>();
    if state.pet_dragging.load(Ordering::SeqCst) && !pressed(VK_LBUTTON) {
        state.pet_dragging.store(false, Ordering::SeqCst);
        let drag_id = state.pet_drag_id.load(Ordering::SeqCst);
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::desktop::finish_pet_drag(&a);
            let _ = a.emit_to("pet", "desktop-pet-drag-ended", serde_json::json!({"dragId":drag_id}));
        });
    }
    if let Some(w) = app.get_webview_window("pet") {
        if w.is_visible().unwrap_or(false) {
            let (x, y) = cursor();
            static LAST_CURSOR: std::sync::Mutex<Option<(i32, i32)>> = std::sync::Mutex::new(None);
            let mut previous = LAST_CURSOR.lock().unwrap();
            if *previous == Some((x, y)) { return; }
            *previous = Some((x, y));
            drop(previous);
            let _ = w.emit("desktop-cursor", serde_json::json!({"x":x,"y":y}));
        }
    }
}
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::sync_channel(256);
    let _ = INPUT.set(tx);
    std::thread::spawn(move || unsafe {
        let mut mutex = None;
        let mut ownership_retry = Instant::now() - Duration::from_secs(1);
        let mut owned = false;
        let mut keyboard = None;
        let mut alt: Option<(Instant, u64)> = None;
        let mut voice = false;
        let mut chord = false;
        let mut down_keys = HashSet::new();
        let mut pointer_update = Instant::now();
        let mut auto_selection = crate::selection::AutoSelection::default();
        let mut selection_hotkeys = crate::selection::Hotkeys::new(&app);

        loop {
            let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
            let active = p.enabled || p.screenshot_enabled || p.pet || p.selection_enabled;
            if !owned && active && ownership_retry.elapsed() >= Duration::from_millis(500) {
                ownership_retry = Instant::now();
                if mutex.is_none() { mutex = CreateMutexW(None, false, w!(r"Local\XiaoXiDesktopAssistant")).ok(); }
                let acquired = mutex.map(|handle| WaitForSingleObject(handle, 0));
                if acquired == Some(WAIT_OBJECT_0) || acquired == Some(WAIT_ABANDONED) {
                    keyboard = SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(hook),
                        GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0)),
                        0,
                    )
                    .ok();
                    owned = keyboard.is_some();
                    if !owned {
                        if let Some(handle) = mutex { let _ = ReleaseMutex(handle); }
                    } else {
                        if p.pet {
                            let a = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                crate::desktop::set_pet_visible(&a, true);
                            });
                        }
                    }
                    app.state::<Desktop>().owned.store(owned, Ordering::SeqCst);
                    publish(&app);
                }
            }
            if owned && !active {
                ALT_ENABLED.store(false, Ordering::SeqCst);
                if let Some(h) = keyboard.take() {
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Some(handle) = mutex { let _ = ReleaseMutex(handle); }
                owned = false;
                app.state::<Desktop>().owned.store(false, Ordering::SeqCst);
                alt = None;
                voice = false;
                publish(&app);
            }
            selection_hotkeys.poll(&app, owned);
            let recording_shortcut = app.state::<crate::selection::Selection>().recording.load(Ordering::SeqCst);
            ALT_ENABLED.store(owned && p.enabled && !recording_shortcut, Ordering::Relaxed);
            SCREENSHOT_ENABLED.store(owned && p.screenshot_enabled && !recording_shortcut, Ordering::Relaxed);
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_HOTKEY && selection_hotkeys.receives(msg.wParam.0) && !recording_shortcut {
                    crate::selection::trigger(&app);
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            while let Ok(e) = rx.try_recv() {
                if e.down {
                    if !down_keys.insert(e.key) {
                        continue;
                    }
                } else {
                    down_keys.remove(&e.key);
                }
                if e.capture && owned && !recording_shortcut {
                    let a = app.clone();
                    std::thread::spawn(move || { if let Err(error) = crate::desktop::begin_capture(&a) {
                        crate::desktop::report_capture_failure(&a, &error);
                    }});
                    continue;
                }
                if !owned || !p.enabled || recording_shortcut {
                    alt = None;
                    if voice {
                        crate::voice::cancel_owner(&app, "quick");
                        voice = false;
                    }
                    continue;
                }
                if e.key == VK_RMENU.0 as u32 {
                    if e.down {
                        if alt.is_none() {
                            alt = Some((e.at, GESTURE.load(Ordering::SeqCst)));
                            chord = e.other_held;
                            voice = false;
                        }
                    } else if let Some((started, gesture)) = alt.take() {
                        if !chord {
                            if voice {
                                crate::voice::stop_gesture(&app, gesture);
                                let _ = app.emit_to(
                                    "quick",
                                    "desktop-release",
                                    serde_json::json!({"gesture":gesture}),
                                );
                            } else if e.at.duration_since(started) < Duration::from_millis(300) {
                                let a = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    if let Err(error) = crate::desktop::toggle_ai(a.clone()) {
                                        let _ = crate::desktop::open_ai(a.clone());
                                        let _ = a.emit_to("quick", "desktop-error", error);
                                    }
                                });
                            }
                        }
                        voice = false;
                    }
                } else if e.down && alt.is_some() {
                    chord = true;
                    if voice {
                        crate::voice::cancel_owner(&app, "quick");
                        let _ = app.emit_to("quick", "desktop-voice-cancel", ());
                        voice = false;
                    }
                }
            }
            if let Some((started, gesture)) = alt {
                if started.elapsed() >= Duration::from_millis(300)
                    && !chord
                    && !voice
                    && gesture_held(gesture)
                    && p.enabled
                {
                    voice = true;
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if !gesture_held(gesture)
                            || a.state::<Desktop>().dialog_active.load(Ordering::SeqCst)
                        {
                            return;
                        }
                        let active = a.get_webview_window("quick")
                                .is_some_and(|w| w.is_visible().unwrap_or(false));
                        if active && a.state::<Desktop>().quick_busy.load(Ordering::SeqCst) {
                            return;
                        }
                        let needs_session = a.state::<Desktop>().ask_session.lock().unwrap().is_empty();
                        if needs_session && crate::desktop::begin_ask_session(&a).is_err() {
                            return;
                        }
                        if crate::desktop::open_ai(a.clone()).is_ok() {
                            crate::desktop::enqueue_quick(&a, crate::desktop::QuickAction::Voice { gesture: Some(gesture) });
                        }
                    });
                }
            }
            if pointer_update.elapsed() >= Duration::from_millis(20) {
                pointer_update = Instant::now();
                pointer_surfaces(&app);
                auto_selection.poll(&app, owned && p.selection_enabled && !p.selection_shortcut_only && !recording_shortcut);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
}
