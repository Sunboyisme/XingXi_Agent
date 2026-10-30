//! Explicit, read-only text selection. Never sends copy keystrokes or reads the clipboard.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use windows::{
    core::Interface,
    Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

const KEY_IDS: [i32; 2] = [0x5810, 0x5811];
#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub id: u64,
    pub text: String,
    pub error: String,
    pub x: i32,
    pub y: i32,
}
struct DomReply {
    id: u64,
    label: String,
    tx: mpsc::SyncSender<String>,
}
struct Change {
    enabled: bool,
    shortcut: String,
    deadline: Instant,
    tx: mpsc::SyncSender<Result<(), String>>,
}
#[derive(Default)]
pub struct Selection {
    pub generation: AtomicU64,
    pub recording: AtomicBool,
    uia_busy: AtomicBool,
    snapshot: Mutex<Snapshot>,
    dom: Mutex<Option<DomReply>>,
    changes: Mutex<Option<mpsc::Sender<Change>>>,
    pub shortcut_error: Mutex<String>,
}

pub fn parse_shortcut(value: &str) -> Result<(HOT_KEY_MODIFIERS, u32), String> {
    let mut modifiers = MOD_NOREPEAT;
    let mut key = None;
    for part in value.split('+') {
        match part {
            "Ctrl" => modifiers |= MOD_CONTROL,
            "Alt" => modifiers |= MOD_ALT,
            "Shift" => modifiers |= MOD_SHIFT,
            key_name => {
                let code = if key_name.len() == 1
                    && key_name
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                {
                    key_name.as_bytes()[0] as u32
                } else if let Some(number) = key_name
                    .strip_prefix('F')
                    .and_then(|s| s.parse::<u32>().ok())
                    .filter(|n| (1..=12).contains(n))
                {
                    VK_F1.0 as u32 + number - 1
                } else {
                    return Err("快捷键请使用 Ctrl／Alt／Shift 加字母、数字或 F1–F12".into());
                };
                if key.replace(code).is_some() {
                    return Err("快捷键只能包含一个普通按键".into());
                }
            }
        }
    }
    if modifiers.0 & (MOD_CONTROL.0 | MOD_ALT.0) == 0 {
        return Err("快捷键至少包含 Ctrl 或 Alt".into());
    }
    Ok((modifiers, key.ok_or("请录制完整的组合键")?))
}

// Register/unregister only on the input thread, which receives WM_HOTKEY.
pub struct Hotkeys {
    rx: mpsc::Receiver<Change>,
    active: Option<(i32, String)>,
    owner: bool,
    suspended: bool,
}
impl Hotkeys {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        *app.state::<Selection>().changes.lock().unwrap() = Some(tx);
        Self {
            rx,
            active: None,
            owner: false,
            suspended: false,
        }
    }
    fn replace(&mut self, enabled: bool, shortcut: &str) -> Result<(), String> {
        let (modifiers, key) = parse_shortcut(shortcut)?;
        if !enabled {
            if let Some((id, _)) = self.active.take() {
                unsafe {
                    let _ = UnregisterHotKey(None, id);
                }
            }
            return Ok(());
        }
        if self
            .active
            .as_ref()
            .is_some_and(|(_, saved)| saved == shortcut)
        {
            return Ok(());
        }
        let id = if self
            .active
            .as_ref()
            .is_some_and(|(id, _)| *id == KEY_IDS[0])
        {
            KEY_IDS[1]
        } else {
            KEY_IDS[0]
        };
        unsafe { RegisterHotKey(None, id, modifiers, key) }.map_err(|_| {
            "该快捷键已被其他程序使用，请录制其他组合键。原绑定已保留。".to_string()
        })?;
        if let Some((previous, _)) = self.active.replace((id, shortcut.into())) {
            unsafe {
                let _ = UnregisterHotKey(None, previous);
            }
        }
        Ok(())
    }
    pub fn poll(&mut self, app: &tauri::AppHandle, owner: bool) {
        let state = app.state::<Selection>();
        let suspended = state.recording.load(Ordering::SeqCst);
        if owner != self.owner || suspended != self.suspended {
            self.owner = owner;
            self.suspended = suspended;
            let p = app
                .state::<crate::desktop::Desktop>()
                .prefs
                .lock()
                .unwrap()
                .clone();
            let error = self
                .replace(
                    owner && !suspended && p.selection_enabled,
                    &p.selection_shortcut,
                )
                .err()
                .unwrap_or_default();
            *state.shortcut_error.lock().unwrap() = error;
            publish(app);
        }
        while let Ok(change) = self.rx.try_recv() {
            if Instant::now() >= change.deadline {
                let _ = change.tx.send(Err("更新快捷键超时，原绑定已保留".into()));
                continue;
            }
            let previous = self.active.clone();
            let result = if owner && !suspended {
                self.replace(change.enabled, &change.shortcut)
            } else {
                parse_shortcut(&change.shortcut).map(|_| ())
            };
            *state.shortcut_error.lock().unwrap() = result.clone().err().unwrap_or_default();
            if change.tx.send(result).is_err() {
                let _ = if let Some((_, shortcut)) = previous {
                    self.replace(true, &shortcut)
                } else {
                    self.replace(false, "Ctrl+Shift+E")
                };
            }
        }
    }
    pub fn receives(&self, id: usize) -> bool {
        self.active
            .as_ref()
            .is_some_and(|(current, _)| *current as usize == id)
    }
}
fn publish(app: &tauri::AppHandle) {
    let _ = app.emit(
        "desktop-preferences",
        crate::desktop::desktop_preferences(app.clone()),
    );
}
pub async fn configure(
    app: tauri::AppHandle,
    enabled: bool,
    shortcut: String,
) -> Result<(), String> {
    parse_shortcut(&shortcut)?;
    let tx = app
        .state::<Selection>()
        .changes
        .lock()
        .unwrap()
        .clone()
        .ok_or("快捷键服务尚未就绪，请稍后保存")?;
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, rx) = mpsc::sync_channel(1);
        tx.send(Change {
            enabled,
            shortcut,
            deadline: Instant::now() + Duration::from_millis(1500),
            tx: reply,
        })
        .map_err(|_| "快捷键服务不可用")?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "更新快捷键超时，请重试")?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn selection_shortcut_recording(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    recording: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在主窗口设置快捷键".into());
    }
    app.state::<Selection>()
        .recording
        .store(recording, Ordering::SeqCst);
    Ok(())
}

pub fn dismiss(app: &tauri::AppHandle) {
    let state = app.state::<Selection>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *state.dom.lock().unwrap() = None;
    *state.snapshot.lock().unwrap() = Snapshot::default();
    if let Some(w) = app.get_webview_window("selection") {
        let _ = w.emit("selection-hidden", generation);
        let _ = w.hide();
    }
}
#[tauri::command]
pub fn selection_dismiss(app: tauri::AppHandle, id: u64) {
    let current = app.state::<Selection>().snapshot.lock().unwrap().id;
    if current == id {
        dismiss(&app);
    }
}
#[tauri::command]
pub fn selection_snapshot(app: tauri::AppHandle) -> Snapshot {
    app.state::<Selection>().snapshot.lock().unwrap().clone()
}
#[tauri::command]
pub fn selection_dom_reply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u64,
    text: String,
) {
    let state = app.state::<Selection>();
    let mut pending = state.dom.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|p| p.id == id && p.label == window.label())
    {
        if let Some(p) = pending.take() {
            let _ = p.tx.try_send(text);
        }
    }
}
#[tauri::command]
pub fn selection_resize(
    app: tauri::AppHandle,
    id: u64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() {
        return Err("划词窗口尺寸无效".into());
    }
    let snapshot = app.state::<Selection>().snapshot.lock().unwrap().clone();
    if snapshot.id != id || id == 0 {
        return Ok(());
    }
    let w = app
        .get_webview_window("selection")
        .ok_or("划词窗口不可用")?;
    let monitor = w
        .monitor_from_point(snapshot.x as f64, snapshot.y as f64)
        .map_err(|e| e.to_string())?
        .or(w.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("无法取得显示器工作区")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (width.clamp(280.0, 900.0) * scale).min(area.size.width as f64);
    let height = (height.clamp(64.0, 850.0) * scale).min(area.size.height as f64);
    w.set_size(PhysicalSize::new(width as u32, height as u32))
        .map_err(|e| e.to_string())?;
    let x = (snapshot.x + 12).clamp(
        area.position.x,
        area.position.x + area.size.width as i32 - width as i32,
    );
    let y = (snapshot.y + 18).clamp(
        area.position.y,
        area.position.y + area.size.height as i32 - height as i32,
    );
    w.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}
pub fn trigger(app: &tauri::AppHandle) {
    let foreground = unsafe { GetForegroundWindow() }.0 as usize;
    if app
        .get_webview_window("selection")
        .and_then(|w| w.hwnd().ok())
        .is_some_and(|h| h.0 as usize == foreground)
    {
        dismiss(app);
        return;
    }
    if app
        .state::<crate::desktop::Desktop>()
        .capture
        .lock()
        .unwrap()
        .is_some()
    {
        return;
    }
    dismiss(app);
    let id = app
        .state::<Selection>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let (x, y) = crate::desktop_input::cursor();
    let own_window = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.hwnd().ok().is_some_and(|h| h.0 as usize == foreground))
        .map(|(label, _)| label);
    let app = app.clone();
    std::thread::spawn(move || {
        if app.state::<Selection>().generation.load(Ordering::SeqCst) != id {
            return;
        }
        let result = if let Some(label) = own_window {
            let (tx, rx) = mpsc::sync_channel(1);
            {
                let state = app.state::<Selection>();
                let mut pending = state.dom.lock().unwrap();
                if state.generation.load(Ordering::SeqCst) != id {
                    return;
                }
                *pending = Some(DomReply {
                    id,
                    label: label.clone(),
                    tx,
                });
            }
            let _ = app.emit_to(&label, "selection-read", id);
            let result = rx
                .recv_timeout(Duration::from_millis(1500))
                .map_err(|_| "读取选中文字超时，请重新选择后再试".to_string());
            let state = app.state::<Selection>();
            let mut pending = state.dom.lock().unwrap();
            if pending.as_ref().is_some_and(|p| p.id == id) {
                *pending = None;
            }
            result
        } else {
            read_external(&app, foreground)
        };
        if app.state::<Selection>().generation.load(Ordering::SeqCst) != id
            || unsafe { GetForegroundWindow() }.0 as usize != foreground
        {
            return;
        }
        let result = result.and_then(|text| {
            if text.trim().is_empty() {
                Err("未读取到选中文字，请先选中文字再按快捷键".into())
            } else if text.chars().count() > 50000 {
                Err("选中文字超过 50,000 字符，请缩小选区".into())
            } else {
                Ok(text)
            }
        });
        let snapshot = Snapshot {
            id,
            x,
            y,
            text: result.as_ref().cloned().unwrap_or_default(),
            error: result.err().unwrap_or_default(),
        };
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if a.state::<Selection>().generation.load(Ordering::SeqCst) != id
                || unsafe { GetForegroundWindow() }.0 as usize != foreground
            {
                return;
            }
            *a.state::<Selection>().snapshot.lock().unwrap() = snapshot.clone();
            let _ = selection_resize(a.clone(), id, 720.0, 76.0);
            if let Some(w) = a.get_webview_window("selection") {
                let _ = w.emit("selection-snapshot", snapshot);
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
    });
}
fn read_external(app: &tauri::AppHandle, foreground: usize) -> Result<String, String> {
    if app
        .state::<Selection>()
        .uia_busy
        .swap(true, Ordering::SeqCst)
    {
        return Err("上次取词仍在等待原软件响应，请稍后再试".into());
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let a = app.clone();
    std::thread::spawn(move || {
        let result = unsafe { read_uia(foreground) }.map_err(|_| {
            "当前软件未提供可读取的选中文字，请在支持文本选区的软件中重试".to_string()
        });
        a.state::<Selection>()
            .uia_busy
            .store(false, Ordering::SeqCst);
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|_| "原软件读取超时，请稍后重新选择文字".to_string())?
}
unsafe fn read_uia(foreground: usize) -> windows::core::Result<String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
        let config: IUIAutomation2 = automation.cast()?;
        config.SetConnectionTimeout(800)?;
        config.SetTransactionTimeout(800)?;
        let mut element = automation.GetFocusedElement()?;
        let walker = automation.ControlViewWalker()?;
        let mut candidates = Vec::new();
        let mut belongs_to_foreground = false;
        // Browser accessibility fragments can live in another process. Validate
        // the native ancestor instead of rejecting these process boundaries.
        for _ in 0..24 {
            if element.CurrentIsPassword()?.as_bool() {
                return Ok(String::new());
            }
            let handle = element.CurrentNativeWindowHandle()?;
            candidates.push(element.clone());
            if !handle.0.is_null() {
                if GetAncestor(handle, GA_ROOT).0 as usize != foreground {
                    break;
                }
                belongs_to_foreground = true;
                if handle.0 as usize == foreground {
                    break;
                }
            }
            match walker.GetParentElement(&element) {
                Ok(parent) => element = parent,
                Err(_) => break,
            }
        }
        if !belongs_to_foreground {
            return Ok(String::new());
        }
        for element in candidates {
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                let ranges = pattern.GetSelection()?;
                let count = ranges.Length()?;
                if count > 32 {
                    return Ok(String::new());
                }
                let mut text = String::new();
                for index in 0..count {
                    let part = ranges.GetElement(index)?.GetText(100001)?.to_string();
                    if !part.is_empty() {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&part);
                    }
                    if text.chars().count() > 50000 {
                        break;
                    }
                }
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
        }
        Ok(String::new())
    }
}
