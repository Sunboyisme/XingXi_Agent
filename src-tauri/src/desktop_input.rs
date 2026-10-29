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
}
static INPUT: OnceLock<mpsc::SyncSender<KeyEvent>> = OnceLock::new();
static ALT_ENABLED: AtomicBool = AtomicBool::new(false);
static ALT_HELD: AtomicBool = AtomicBool::new(false);
static ALT_SUPPRESSED: AtomicBool = AtomicBool::new(false);
static GESTURE: AtomicU64 = AtomicU64::new(0);
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
            let other_held = if e.vkCode == VK_RMENU.0 as u32 && down {
                (8..255).any(|k| {
                    k != VK_MENU.0 as i32
                        && k != VK_RMENU.0 as i32
                        && unsafe { GetAsyncKeyState(k) } < 0
                })
            } else {
                false
            };
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
                });
            }
            if consume_alt {
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
            let _ = w.emit("desktop-cursor", serde_json::json!({"x":x,"y":y}));
        }
    }
}
pub fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::sync_channel(256);
    let _ = INPUT.set(tx);
    std::thread::spawn(move || unsafe {
        let Ok(mutex) = CreateMutexW(None, false, w!("Local\\XiaoXiDesktopAssistant")) else {
            return;
        };
        let mut owned = false;
        let mut keyboard = None;
        let mut alt: Option<(Instant, u64)> = None;
        let mut voice = false;
        let mut chord = false;
        let mut down_keys = HashSet::new();
        let mut pointer_update = Instant::now();

        loop {
            let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
            let active = p.enabled || p.pet;
            if !owned && active {
                let acquired = WaitForSingleObject(mutex, 0);
                if acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED {
                    keyboard = SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(hook),
                        GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0)),
                        0,
                    )
                    .ok();
                    owned = keyboard.is_some();
                    if !owned {
                        let _ = ReleaseMutex(mutex);
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
                let _ = ReleaseMutex(mutex);
                owned = false;
                app.state::<Desktop>().owned.store(false, Ordering::SeqCst);
                alt = None;
                voice = false;
                publish(&app);
            }
            ALT_ENABLED.store(owned && p.enabled, Ordering::Relaxed);
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
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
                if !owned || !p.enabled {
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
                                    if let Err(error) = crate::desktop::desktop_toggle(a.clone()) {
                                        let _ = crate::desktop::desktop_open(a.clone(), false);
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
                        let active = a.state::<Desktop>().capture.lock().unwrap().is_some()
                            || a.get_webview_window("quick")
                                .is_some_and(|w| w.is_visible().unwrap_or(false));
                        if active && a.state::<Desktop>().quick_busy.load(Ordering::SeqCst) {
                            return;
                        }
                        if !active && crate::desktop::begin_ask_session(&a).is_err() {
                            return;
                        }
                        let text = a
                            .state::<Desktop>()
                            .capture
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|capture| capture.draft_text.clone())
                            .unwrap_or_else(|| {
                                a.state::<Desktop>().quick_text.lock().unwrap().clone()
                            });
                        if crate::desktop::desktop_record(a.clone()).is_ok() {
                            crate::desktop::enqueue_quick(
                                &a,
                                "record",
                                Some(text),
                                None,
                                Some(gesture),
                                None,
                            );
                        }
                    });
                }
            }
            if pointer_update.elapsed() >= Duration::from_millis(20) {
                pointer_update = Instant::now();
                pointer_surfaces(&app);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
}
