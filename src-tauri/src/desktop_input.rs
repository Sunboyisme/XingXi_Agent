//! Desktop input ownership, native hotkeys, and read-only selection capture.
use crate::desktop::{Desktop, Preferences};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
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
struct KeyEvent {
    key: u32,
    down: bool,
    at: Instant,
    other_held: bool,
}
struct Configure {
    prefs: Preferences,
    reply: mpsc::SyncSender<Result<(), String>>,
}
static INPUT: OnceLock<mpsc::SyncSender<KeyEvent>> = OnceLock::new();
static CONFIG: OnceLock<mpsc::SyncSender<Configure>> = OnceLock::new();
static DOM: std::sync::LazyLock<Mutex<HashMap<String, (String, mpsc::SyncSender<String>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static VERSION: AtomicU64 = AtomicU64::new(0);
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
pub fn offer_dom(label: String, text: String, request_id: Option<String>) {
    if let Some(id) = request_id {
        let mut requests = DOM.lock().unwrap();
        if requests
            .get(&id)
            .is_some_and(|(source, _)| source == &label)
        {
            if let Some((_, reply)) = requests.remove(&id) {
                let _ = reply.send(text.chars().take(20001).collect());
            }
        }
    }
}
pub fn invalidate_selection() {
    VERSION.fetch_add(1, Ordering::SeqCst);
}
pub fn gesture_held(gesture: u64) -> bool {
    ALT_HELD.load(Ordering::SeqCst) && GESTURE.load(Ordering::SeqCst) == gesture
}
#[tauri::command]
pub fn desktop_key_state() -> serde_json::Value {
    serde_json::json!({"held":ALT_HELD.load(Ordering::SeqCst),"gesture":GESTURE.load(Ordering::SeqCst)})
}
pub fn parse_shortcut(value: &str) -> Result<(u32, u16), String> {
    let mut modifiers = 0;
    let mut key = 0;
    for token in value.split('+').map(|s| s.trim().to_uppercase()) {
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
                    .and_then(|s| s.parse::<u16>().ok())
                    .filter(|n| (1..=12).contains(n))
                {
                    VK_F1.0 + n - 1
                } else {
                    return Err("请使用修饰键与字母、数字或 F1–F12 组合".into());
                };
            }
        }
    }
    if modifiers == 0 || key == 0 {
        return Err("请同时按下修饰键和一个普通按键".into());
    }
    Ok((modifiers, key))
}
pub fn configure_shortcut(prefs: Preferences) -> Result<(), String> {
    parse_shortcut(&prefs.shortcut)?;
    let (reply, rx) = mpsc::sync_channel(1);
    CONFIG
        .get()
        .ok_or("桌面快捷键尚未就绪")?
        .send(Configure { prefs, reply })
        .map_err(|_| "桌面快捷键服务已停止")?;
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "快捷键更新超时，请重试")?
}
#[tauri::command]
pub async fn desktop_shortcut_recording(
    app: tauri::AppHandle,
    recording: bool,
) -> Result<(), String> {
    app.state::<Desktop>()
        .shortcut_recording
        .store(recording, Ordering::SeqCst);
    let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || configure_shortcut(p))
        .await
        .map_err(|e| e.to_string())?
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
struct Hotkey {
    registered: Option<(i32, u32, u16)>,
}
impl Hotkey {
    unsafe fn set(&mut self, p: &Preferences, enabled: bool) -> Result<(), String> {
        let (mods, key) = parse_shortcut(&p.shortcut)?;
        if !enabled {
            if let Some((id, _, _)) = self.registered.take() {
                let _ = unsafe { UnregisterHotKey(None, id) };
            }
            return Ok(());
        }
        if self
            .registered
            .is_some_and(|(_, m, k)| m == mods && k == key)
        {
            return Ok(());
        }
        let id = if self.registered.is_some_and(|(id, _, _)| id == 0x5819) {
            0x581a
        } else {
            0x5819
        };
        let flags = HOT_KEY_MODIFIERS(
            MOD_NOREPEAT.0
                | if mods & 1 != 0 { MOD_CONTROL.0 } else { 0 }
                | if mods & 2 != 0 { MOD_SHIFT.0 } else { 0 }
                | if mods & 4 != 0 { MOD_ALT.0 } else { 0 }
                | if mods & 8 != 0 { MOD_WIN.0 } else { 0 },
        );
        unsafe { RegisterHotKey(None, id, flags, key as u32) }
            .map_err(|_| "这个快捷键已被其他应用占用，请换一个组合")?;
        if let Some((old, _, _)) = self.registered.replace((id, mods, key)) {
            let _ = unsafe { UnregisterHotKey(None, old) };
        }
        Ok(())
    }
}
fn publish(app: &tauri::AppHandle) {
    let _ = app.emit(
        "desktop-preferences",
        crate::desktop::desktop_preferences(app.clone()),
    );
}
fn request_selection(
    app: &tauri::AppHandle,
    java: std::sync::Arc<crate::java_selection::JavaSelection>,
) {
    unsafe {
        let generation = VERSION.fetch_add(1, Ordering::SeqCst) + 1;
        let target = GetForegroundWindow();
        let address = target.0 as isize;
        let mut pid = 0;
        GetWindowThreadProcessId(target, Some(&mut pid));
        let label = if pid == std::process::id() {
            app.webview_windows()
                .values()
                .find(|w| w.hwnd().ok().is_some_and(|h| h.0 as isize == address))
                .map(|w| w.label().to_string())
        } else {
            None
        };
        if label.as_deref() == Some("selection") {
            crate::desktop::desktop_selection_dismiss(app.clone(), None);
            return;
        }
        let a = app.clone();
        std::thread::spawn(move || {
            let local = label.and_then(|label| {
                let ticket = uuid::Uuid::new_v4().to_string();
                let (reply, rx) = mpsc::sync_channel(1);
                DOM.lock()
                    .unwrap()
                    .insert(ticket.clone(), (label.clone(), reply));
                let _ = a.emit_to(
                    &label,
                    "desktop-selection-request",
                    serde_json::json!({"requestId":ticket}),
                );
                let value = rx.recv_timeout(Duration::from_millis(300)).ok();
                DOM.lock().unwrap().remove(&ticket);
                value
            });
            let text = if let Some(text) = local {
                if text.trim().is_empty() {
                    None
                } else {
                    Some(text)
                }
            } else {
                selected_text(pid).or_else(|| java.selected(address))
            };
            if VERSION.load(Ordering::SeqCst) != generation
                || GetForegroundWindow().0 as isize != address
                || !a.state::<Desktop>().prefs.lock().unwrap().selection
            {
                return;
            }
            let error = if text.is_none() {
                Some("无法读取选中文字，请重新选择。这个应用可能未提供无障碍取词支持。".into())
            } else {
                None
            };
            let b = a.clone();
            let _ = a.run_on_main_thread(move || {
                if VERSION.load(Ordering::SeqCst) == generation {
                    crate::desktop::offer_selection(&b, text.unwrap_or_default(), error);
                }
            });
        });
    }
}
fn pointer_surfaces(app: &tauri::AppHandle) {
    let state = app.state::<Desktop>();
    if state.pet_dragging.load(Ordering::SeqCst) && !pressed(VK_LBUTTON) {
        state.pet_dragging.store(false, Ordering::SeqCst);
        crate::desktop::persist_pet_position(app);
        let _ = app.emit_to("pet", "desktop-pet-drag-ended", ());
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
    let (config_tx, config_rx) = mpsc::sync_channel(16);
    let _ = CONFIG.set(config_tx);
    std::thread::spawn(move || unsafe {
        let Ok(mutex) = CreateMutexW(None, false, w!("Local\\XiaoXiDesktopAssistant")) else {
            return;
        };
        let mut owned = false;
        let mut keyboard = None;
        let mut hotkey = Hotkey { registered: None };
        let mut alt: Option<(Instant, u64)> = None;
        let mut voice = false;
        let mut chord = false;
        let mut down_keys = HashSet::new();
        let mut pointer_update = Instant::now();

        let java = std::sync::Arc::new(crate::java_selection::JavaSelection::new());
        loop {
            let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
            let recording = app
                .state::<Desktop>()
                .shortcut_recording
                .load(Ordering::SeqCst);
            let active = p.enabled || p.pet || p.selection;
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
                        let result = hotkey.set(&p, p.selection && !recording);
                        *app.state::<Desktop>().shortcut_error.lock().unwrap() =
                            result.err().unwrap_or_default();
                        if p.pet {
                            let a = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                if let Some(w) = a.get_webview_window("pet") {
                                    let _ = w.show();
                                }
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
                let _ = hotkey.set(&p, false);
                let _ = ReleaseMutex(mutex);
                owned = false;
                app.state::<Desktop>().owned.store(false, Ordering::SeqCst);
                alt = None;
                voice = false;
                publish(&app);
            }
            ALT_ENABLED.store(owned && p.enabled && !recording, Ordering::Relaxed);
            while let Ok(change) = config_rx.try_recv() {
                let result = hotkey.set(
                    &change.prefs,
                    owned
                        && change.prefs.selection
                        && !app
                            .state::<Desktop>()
                            .shortcut_recording
                            .load(Ordering::SeqCst),
                );
                *app.state::<Desktop>().shortcut_error.lock().unwrap() =
                    result.as_ref().err().cloned().unwrap_or_default();
                let _ = change.reply.send(result);
            }
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_HOTKEY && owned && p.selection && !recording {
                    request_selection(&app, java.clone());
                } else {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            while let Ok(e) = rx.try_recv() {
                if e.down {
                    if !down_keys.insert(e.key) {
                        continue;
                    }
                } else {
                    down_keys.remove(&e.key);
                }
                if e.down && e.key == VK_ESCAPE.0 as u32 {
                    invalidate_selection();
                }
                if !owned || !p.enabled || recording {
                    alt = None;
                    if voice {
                        crate::voice::voice_cancel(app.state(), None);
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
                        crate::voice::voice_cancel(app.state(), None);
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
                    && !recording
                {
                    voice = true;
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if gesture_held(gesture)
                            && !a.state::<Desktop>().quick_busy.load(Ordering::Relaxed)
                            && !a.state::<Desktop>().dialog_active.load(Ordering::SeqCst)
                        {
                            let _ = crate::desktop::desktop_open(a.clone(), false);
                            let _ = a.emit_to(
                                "quick",
                                "desktop-record",
                                serde_json::json!({"gesture":gesture}),
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
