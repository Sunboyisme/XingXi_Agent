//! Native owner of desktop surfaces. Runtime data stays in the current app data directory.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Serialize, Deserialize)]
pub struct SelectionModel { pub provider_id: String, pub model_name: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub screenshot_enabled: bool,
    pub selection_shortcut_only: bool,
    pub selection_model: Option<SelectionModel>,
    pub pet: bool,
    pub pomodoro: bool,
    pub pomodoro_theme: String,
    pub pet_x: Option<i32>,
    pub pet_y: Option<i32>,
    pub pet_size: u16,
    pub pet_offset_x: Option<f64>,
    pub pet_offset_y: Option<f64>,
    pub selection_enabled: bool,
    pub selection_shortcut: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencePatch {
    pub enabled: Option<bool>,
    pub screenshot_enabled: Option<bool>,
    pub selection_shortcut_only: Option<bool>,
    #[serde(default, deserialize_with = "selection_model_patch")]
    pub selection_model: Option<Option<SelectionModel>>,
    pub pet: Option<bool>,
    pub pomodoro: Option<bool>,
    pub pomodoro_theme: Option<String>,
    pub pet_size: Option<u16>,
    pub selection_enabled: Option<bool>,
    pub selection_shortcut: Option<String>,
}
fn selection_model_patch<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<SelectionModel>>, D::Error> {
    Option::<SelectionModel>::deserialize(deserializer).map(Some)
}
#[derive(Clone, Deserialize)]
pub struct HitRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub border_radius: f64,
}
#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum QuickAction {
    Voice { gesture: Option<u64> },
    Image { data_url: String, image_action: String },
    Resume { run_id: String },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    id: String,
    session_id: String,
    #[serde(flatten)]
    payload: QuickAction,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            screenshot_enabled: true,
            selection_shortcut_only: false,
            selection_model: None,
            pet: true,
            pomodoro: true,
            pomodoro_theme: "follow".into(),
            pet_x: None,
            pet_y: None,
            pet_size: 100,
            pet_offset_x: None,
            pet_offset_y: None,
            selection_enabled: true,
            selection_shortcut: "Alt+S".into(),
        }
    }
}
#[derive(Default)]
pub struct Desktop {
    pub capture_starting: AtomicBool,
    capture_epoch: AtomicU64,
    pub prefs: Mutex<Preferences>,
    pub owned: AtomicBool,
    pub pet_dragging: AtomicBool,
    pub pet_drag_id: AtomicU64,
    pub pet_visibility_epoch: AtomicU64,
    pub pet_exiting: AtomicBool,
    pub quick_busy: AtomicBool,
    pub quick_epoch: AtomicU64,
    pub dialog_active: AtomicBool,
    pub hit_regions: Mutex<std::collections::HashMap<String, Vec<HitRegion>>>,
    pub capture: Mutex<Option<Capture>>,
    pub hidden: Mutex<Vec<String>>,
    pub ask_session: Mutex<String>,
    pub quick_commands: Mutex<Vec<QuickCommand>>,
}
pub struct Capture {
    pub id: String,
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

fn path(app: &tauri::AppHandle) -> PathBuf {
    app.state::<crate::Backend>()
        .data_dir
        .get()
        .unwrap()
        .join("desktop-assistant.json")
}
static PREFERENCE_SAVE_LOCK: std::sync::LazyLock<tauri::async_runtime::Mutex<()>> =
    std::sync::LazyLock::new(|| tauri::async_runtime::Mutex::new(()));
fn window(
    app: &tauri::AppHandle,
    label: &str,
    width: f64,
    height: f64,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?view={label}").into()),
    )
    .title("XiaoXi")
    .inner_size(width, height)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())
}
pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Ok(bytes) = std::fs::read(path(app)) {
        if let Ok(mut p) = serde_json::from_slice::<Preferences>(&bytes) {
            p.pet_size = p.pet_size.clamp(50, 200);
            if p.selection_shortcut == "Ctrl+Shift+E" { p.selection_shortcut = "Alt+S".into(); }
            if let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if raw.get("screenshotEnabled").is_none() { p.screenshot_enabled = p.enabled; }
            }
            if !pomodoro_theme_valid(&p.pomodoro_theme) { p.pomodoro_theme = "follow".into(); }
            *app.state::<Desktop>().prefs.lock().unwrap() = p;
        }
    }
    window(app, "quick", 900.0, 540.0)?;
    window(app, "capture", 900.0, 600.0)?;
    window(app, "selection", 720.0, 76.0)?;
    let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
    let (pet_width, pet_height) = pet_window_dimensions(p.pet_size);
    let pet = window(app, "pet", pet_width, pet_height)?;
    if let Some(m) = pet.primary_monitor().map_err(|e| e.to_string())? {
        let area = m.work_area();
        if let (Some(x), Some(y)) = (p.pet_x, p.pet_y) {
            pet.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            place_pet(app, false)?;
        } else {
            let scale = m.scale_factor();
            let diameter = (82.0 * f64::from(p.pet_size) / 100.0 * scale).round() as i32;
            let x = area.position.x + (f64::from(area.size.width) * 0.92).round() as i32 - diameter / 2;
            let y = area.position.y + (f64::from(area.size.height) * 0.615).round() as i32 - diameter / 2;
            position_pet(app, &pet, area, x, y, PhysicalSize::new((pet_width * scale).round() as u32, (pet_height * scale).round() as u32), scale)?;
        }
    }
    crate::desktop_input::start(app.clone());
    Ok(())
}
#[tauri::command]
pub fn desktop_preferences(app: tauri::AppHandle) -> serde_json::Value {
    let d = app.state::<Desktop>();
    let quick_epoch = d.quick_epoch.load(Ordering::SeqCst);
    let quick_shown = app.get_webview_window("quick").is_some_and(|w| w.is_visible().unwrap_or(false));
    let double_click_ms = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
    serde_json::json!({"preferences":d.prefs.lock().unwrap().clone(),"ownsShortcuts":d.owned.load(Ordering::Relaxed),"selectionShortcutError":app.state::<crate::selection::Selection>().shortcut_error.lock().unwrap().clone(),"quickShown":quick_shown,"quickEpoch":quick_epoch,"doubleClickMs":double_click_ms})
}
#[tauri::command]
pub async fn desktop_preferences_save(
    app: tauri::AppHandle,
    preferences: PreferencePatch,
) -> Result<serde_json::Value, String> {
    let _save = PREFERENCE_SAVE_LOCK.lock().await;
    let mut next = app.state::<Desktop>().prefs.lock().unwrap().clone();
    let previous = next.clone();
    let old_pet_size = next.pet_size;
    if let Some(v) = preferences.enabled {
        next.enabled = v;
    }
    if let Some(v) = preferences.screenshot_enabled { next.screenshot_enabled = v; }
    if let Some(v) = preferences.selection_shortcut_only { next.selection_shortcut_only = v; }
    if let Some(v) = preferences.selection_model {
        next.selection_model = v.filter(|model| !model.provider_id.is_empty() && !model.model_name.is_empty());
    }
    if let Some(v) = preferences.pet {
        next.pet = v;
    }
    if let Some(v) = preferences.pomodoro {
        next.pomodoro = v;
    }
    if let Some(v) = preferences.pomodoro_theme {
        if !pomodoro_theme_valid(&v) { return Err("未知桌面番茄钟主题".into()); }
        next.pomodoro_theme = v;
    }
    let selection_changed = preferences.selection_enabled.is_some() || preferences.selection_shortcut.is_some();
    if let Some(v) = preferences.selection_enabled { next.selection_enabled = v; }
    if let Some(v) = preferences.selection_shortcut { next.selection_shortcut = v; }
    if let Some(v) = preferences.pet_size {
        if !(50..=200).contains(&v) {
            return Err("桌宠大小需在 50% 到 200% 之间".into());
        }
        next.pet_size = v;
    }
    if selection_changed {
        crate::selection::configure(app.clone(), next.selection_enabled, next.selection_shortcut.clone()).await?;
    }
    let preferences = next;
    let state = app.state::<Desktop>();
    let persisted = {
        let mut current = state.prefs.lock().unwrap();
        let mut next = preferences.clone();
        next.pet_x = current.pet_x;
        next.pet_y = current.pet_y;
        next.pet_offset_x = current.pet_offset_x;
        next.pet_offset_y = current.pet_offset_y;
        let result = persist_preferences(&app, &next);
        if result.is_ok() {
            *current = next;
        }
        result
    };
    if let Err(error) = persisted {
        if selection_changed { let _ = crate::selection::configure(app.clone(), previous.selection_enabled, previous.selection_shortcut).await; }
        return Err(error);
    }
    if !preferences.selection_enabled { crate::selection::dismiss(&app); }
    if let Some(pet) = app.get_webview_window("pet") {
        if old_pet_size != preferences.pet_size {
            let (width, height) = pet_window_dimensions(preferences.pet_size);
            pet.set_size(tauri::LogicalSize::new(
                width,
                height,
            ))
            .map_err(|e| e.to_string())?;
        }
        if old_pet_size != preferences.pet_size {
            place_pet(&app, false)?;
        }
        set_pet_visible(
            &app,
            preferences.pet && app.state::<Desktop>().owned.load(Ordering::Relaxed),
        );
    }
    if !preferences.enabled {
        finish_capture(&app, None);
        desktop_dismiss_label(&app, "quick");
    }
    crate::pomodoro::preferences_changed(&app, previous.pomodoro, preferences.pomodoro);
    let value = desktop_preferences(app.clone());
    let _ = app.emit("desktop-preferences", &value);
    Ok(value)
}
fn persist_preferences(app: &tauri::AppHandle, p: &Preferences) -> Result<(), String> {
    let target = path(app);
    let temp = target.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, target).map_err(|e| e.to_string())
}
fn pomodoro_theme_valid(value: &str) -> bool {
    matches!(value, "follow" | "warm-dark" | "cream" | "mist-blue" | "sage" | "plum")
}
// Clamp the visible avatar, and reposition its transparent frame so the bubble
// and context menu stay accessible at the top and left monitor edges as well.
fn place_pet(app: &tauri::AppHandle, reset: bool) -> Result<(), String> {
    let w = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
    let at = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let diameter = (82.0 * p.pet_size as f64 / 100.0 * scale).round() as i32;
    let right = (8.0 * scale).round() as i32;
    let bottom = (6.0 * scale).round() as i32;
    let left = at.x
        + p.pet_offset_x
            .map(|x| (x * scale).round() as i32)
            .unwrap_or(size.width as i32 - right - diameter);
    let top = at.y
        + p.pet_offset_y
            .map(|y| (y * scale).round() as i32)
            .unwrap_or(size.height as i32 - bottom - diameter);
    let (cx, cy) = if reset {
        crate::desktop_input::cursor()
    } else {
        (left + diameter / 2, top + diameter / 2)
    };
    let monitor = w
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .min_by_key(|m| {
            let a = m.work_area();
            let dx = (cx as i64
                - (cx as i64).clamp(
                    a.position.x as i64,
                    a.position.x as i64 + a.size.width as i64,
                ))
            .abs();
            let dy = (cy as i64
                - (cy as i64).clamp(
                    a.position.y as i64,
                    a.position.y as i64 + a.size.height as i64,
                ))
            .abs();
            dx * dx + dy * dy
        })
        .ok_or("无法读取显示器工作区")?;
    let a = monitor.work_area();
    let target_scale = monitor.scale_factor();
    let target_diameter = (82.0 * p.pet_size as f64 / 100.0 * target_scale).round() as i32;
    let (width, height) = pet_window_dimensions(p.pet_size);
    let target_size = PhysicalSize::new(
        ((width * target_scale).round() as u32).min(a.size.width),
        ((height * target_scale).round() as u32).min(a.size.height),
    );
    if reset {
        // Use the destination DPI: moving from a differently scaled screen must
        // place the visible avatar at the screenshot's relative default location.
        let x = a.position.x + (f64::from(a.size.width) * 0.92).round() as i32 - target_diameter / 2;
        let y = a.position.y + (f64::from(a.size.height) * 0.615).round() as i32 - target_diameter / 2;
        return position_pet(app, &w, a, x, y, target_size, target_scale);
    }
    let min_x = a.position.x;
    let min_y = a.position.y;
    let max_x = (min_x + a.size.width as i32 - target_diameter).max(min_x);
    let max_y = (min_y + a.size.height as i32 - target_diameter - (72.0 * target_scale).round() as i32).max(min_y);
    let x = (cx - target_diameter / 2).clamp(min_x, max_x);
    let y = (cy - target_diameter / 2).clamp(min_y, max_y);
    position_pet(app, &w, a, x, y, target_size, target_scale)
}
fn position_pet(
    app: &tauri::AppHandle,
    w: &tauri::WebviewWindow,
    area: &tauri::PhysicalRect<i32, u32>,
    x: i32,
    y: i32,
    size: PhysicalSize<u32>,
    scale: f64,
) -> Result<(), String> {
    let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
    let diameter = (82.0 * p.pet_size as f64 / 100.0 * scale).round() as i32;
    let origin_x = (x + diameter + (8.0 * scale).round() as i32 - size.width as i32).clamp(
        area.position.x,
        (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x),
    );
    let origin_y = (y + diameter + (72.0 * scale).round() as i32 - size.height as i32).clamp(
        area.position.y,
        (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y),
    );
    w.set_position(PhysicalPosition::new(origin_x, origin_y))
        .map_err(|e| e.to_string())?;
    // Apply physical size after the move, once Windows has adopted the destination DPI.
    if w.outer_size().map_err(|e| e.to_string())? != size {
        w.set_size(size).map_err(|e| e.to_string())?;
    }
    let offset_x = (x - origin_x) as f64 / scale;
    let offset_y = (y - origin_y) as f64 / scale;
    {
        let state = app.state::<Desktop>();
        let mut p = state.prefs.lock().unwrap();
        p.pet_x = Some(origin_x);
        p.pet_y = Some(origin_y);
        p.pet_offset_x = Some(offset_x);
        p.pet_offset_y = Some(offset_y);
        persist_preferences(app, &p)?;
    }
    let _ = w.emit(
        "desktop-pet-layout",
        serde_json::json!({"x":offset_x,"y":offset_y,"size":p.pet_size}),
    );
    Ok(())
}
pub fn finish_pet_drag(app: &tauri::AppHandle) {
    if app.state::<Desktop>().pet_dragging.load(Ordering::SeqCst) {
        return;
    }
    let _ = place_pet(app, false);
}
fn pet_window_dimensions(size: u16) -> (f64, f64) {
    (452.0, 82.0 * size as f64 / 100.0 + 360.0)
}
#[tauri::command]
pub fn desktop_pet_reset(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    place_pet(&app, true)?;
    let value = desktop_preferences(app.clone());
    let _ = app.emit("desktop-preferences", &value);
    Ok(value)
}
pub fn set_pet_visible(app: &tauri::AppHandle, shown: bool) {
    let Some(w) = app.get_webview_window("pet") else {
        return;
    };
    let state = app.state::<Desktop>();
    if shown && w.is_visible().unwrap_or(false) && !state.pet_exiting.load(Ordering::SeqCst) {
        return;
    }
    let epoch = state.pet_visibility_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    state.pet_exiting.store(!shown, Ordering::SeqCst);
    if shown {
        if state.capture.lock().unwrap().is_some() {
            let mut hidden = state.hidden.lock().unwrap();
            if !hidden.iter().any(|label| label == "pet") {
                hidden.push("pet".into());
            }
            return;
        }
        let _ = show_without_focus(&w);
        let _ = w.emit(
            "desktop-pet-presence",
            serde_json::json!({"shown":true,"epoch":epoch}),
        );
    } else {
        let _ = w.emit(
            "desktop-pet-presence",
            serde_json::json!({"shown":false,"epoch":epoch}),
        );
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(520));
            let b = a.clone();
            let _ = a.run_on_main_thread(move || {
                if b.state::<Desktop>()
                    .pet_visibility_epoch
                    .load(Ordering::SeqCst)
                    == epoch
                    && b.state::<Desktop>().pet_exiting.load(Ordering::SeqCst)
                {
                    if let Some(w) = b.get_webview_window("pet") {
                        let _ = w.hide();
                    }
                }
            });
        });
    }
}
pub(crate) fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
            windows::Win32::Foundation::HWND(hwnd.0),
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
        );
    }
    Ok(())
}
fn restore_capture_windows(app: &tauri::AppHandle) {
    let state = app.state::<Desktop>();
    let preferences = state.prefs.lock().unwrap().clone();
    let hidden = std::mem::take(&mut *state.hidden.lock().unwrap());
    for label in hidden {
        if label == "pomodoro-timer" {
            crate::pomodoro::refresh_visibility(app);
            continue;
        }
        if (label == "pet" && !preferences.pet) || (label == "quick" && !preferences.enabled) {
            continue;
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _ = show_without_focus(&window);
            if label == "quick" {
                quick_presence(app, true);
                let _ = window.emit("desktop-shown", serde_json::json!({"focus":false}));
            }
        }
    }
}
pub fn report_capture_failure(app: &tauri::AppHandle, message: &str) {
    let _ = app
        .notification()
        .builder()
        .title("截图未能完成")
        .body(message.chars().take(240).collect::<String>())
        .show();
}
#[tauri::command]
pub fn capture_failed(app: tauri::AppHandle, id: String, message: String) {
    if finish_capture(&app, Some(&id)) {
        report_capture_failure(&app, &message);
    }
}
fn finish_capture(app: &tauri::AppHandle, id: Option<&str>) -> bool {
    let state = app.state::<Desktop>();
    let capture = {
        let mut current = state.capture.lock().unwrap();
        if id.is_some_and(|id| !current.as_ref().is_some_and(|value| value.id == id)) {
            return false;
        }
        state.capture_epoch.fetch_add(1, Ordering::SeqCst);
        current.take()
    };
    if let Some(capture) = &capture {
        if let Some(window) = app.get_webview_window("capture") {
            let _ = window.emit("capture-dismiss", &capture.id);
            let _ = window.hide();
        }
    }
    restore_capture_windows(app);
    capture.is_some()
}

pub fn desktop_dismiss_label(app: &tauri::AppHandle, label: &str) {
    if label == "pomodoro-timer" { crate::pomodoro::hide_widget(app); return; }
    if label == "selection" { crate::selection::dismiss(app); return; }
    if label == "capture" {
        finish_capture(app, None);
        return;
    }
    if label == "quick" {
        crate::voice::cancel_owner(app, "quick");
        app.state::<Desktop>()
            .quick_commands
            .lock()
            .unwrap()
            .retain(|command| matches!(&command.payload, QuickAction::Image { .. } | QuickAction::Resume { .. }));
        let session_id = app.state::<Desktop>().ask_session.lock().unwrap().clone();
        let _ = app.emit_to(
            "quick",
            "desktop-hidden",
            serde_json::json!({"sessionId":session_id}),
        );
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
        if label == "quick" { quick_presence(app, w.is_visible().unwrap_or(false)); }
    }
}
fn quick_presence(app: &tauri::AppHandle, shown: bool) {
    let epoch = app.state::<Desktop>().quick_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to("pet", "desktop-quick-presence", serde_json::json!({"shown":shown,"epoch":epoch}));
}
#[tauri::command]
pub fn desktop_dismiss_quick(app: tauri::AppHandle) {
    desktop_dismiss_label(&app, "quick");
}
#[tauri::command]
pub fn desktop_dismiss(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    desktop_dismiss_label(&app, window.label());
}
pub fn toggle_ai(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if app.state::<Desktop>().capture.lock().unwrap().is_some() {
        desktop_dismiss_label(&app, "capture");
        return open_ai(app);
    }
    if app
        .get_webview_window("quick")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        desktop_dismiss_label(&app, "quick");
        return Ok(());
    }
    open_ai(app)
}
pub fn begin_ask_session(app: &tauri::AppHandle) -> Result<String, String> {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
        quick_presence(app, w.is_visible().unwrap_or(false));
    }
    crate::voice::cancel_owner(app, "quick");
    let id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<Desktop>();
    let mut session = state.ask_session.lock().unwrap();
    *session = id.clone();
    state.quick_commands.lock().unwrap().clear();
    state.quick_busy.store(false, Ordering::SeqCst);
    drop(session);
    app.emit_to("quick", "desktop-session", serde_json::json!({"id":id}))
        .map_err(|e| e.to_string())?;
    Ok(id)
}
#[tauri::command]
pub fn desktop_ask_session(app: tauri::AppHandle) -> String {
    app.state::<Desktop>().ask_session.lock().unwrap().clone()
}
#[tauri::command]
pub fn desktop_commands_take(app: tauri::AppHandle, session_id: String) -> Vec<QuickCommand> {
    let state = app.state::<Desktop>();
    let session = state.ask_session.lock().unwrap();
    if *session != session_id {
        return vec![];
    }
    let commands = std::mem::take(&mut *state.quick_commands.lock().unwrap());
    commands
}
pub fn enqueue_quick(app: &tauri::AppHandle, payload: QuickAction) {
    let state = app.state::<Desktop>();
    let session = state.ask_session.lock().unwrap();
    let session_id = session.clone();
    state.quick_commands.lock().unwrap().push(QuickCommand {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        payload,
    });
    drop(session);
    let _ = app.emit_to(
        "quick",
        "desktop-command",
        serde_json::json!({"sessionId":session_id}),
    );
}
pub fn open_ai(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !app.state::<Desktop>().prefs.lock().unwrap().enabled {
        return Err("AI 对话已关闭，请在桌面助手设置中开启".into());
    }
    finish_capture(&app, None);
    if app
        .state::<Desktop>()
        .ask_session
        .lock()
        .unwrap()
        .is_empty()
    {
        begin_ask_session(&app)?;
    }
    show_quick_window(&app)
}
#[tauri::command]
pub async fn desktop_ai_open(app: tauri::AppHandle) -> Result<(), String> {
    open_ai(app)
}
#[tauri::command]
pub async fn desktop_capture_begin(app: tauri::AppHandle) -> Result<(), String> {
    begin_capture(&app)
}
#[tauri::command]
pub fn desktop_resume(app: tauri::AppHandle, run_id: Option<String>) -> Result<(), String> {
    desktop_start(app.clone(), Some(false), Some(false))?;
    if let Some(id) = run_id {
        enqueue_quick(&app, QuickAction::Resume { run_id: id });
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_start(
    app: tauri::AppHandle,
    new_chat: Option<bool>,
    voice: Option<bool>,
) -> Result<(), String> {
    if !app.state::<Desktop>().prefs.lock().unwrap().enabled {
        return Err("AI 对话已关闭，请在桌面助手设置中开启".into());
    }
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if new_chat.unwrap_or(false)
        || app
            .state::<Desktop>()
            .ask_session
            .lock()
            .unwrap()
            .is_empty()
    {
        begin_ask_session(&app)?;
    }
    open_ai(app.clone())?;
    if voice.unwrap_or(false) {
        // Open the editor first. Its current run/upload/recording state decides
        // whether to start recording; a cached busy flag must not block reopening.
        enqueue_quick(&app, QuickAction::Voice { gesture: None });
    }
    Ok(())
}

fn show_quick_window(app: &tauri::AppHandle) -> Result<(), String> {
    let w = window(app, "quick", 900.0, 540.0)?;
    let (x, y) = crate::desktop_input::cursor();
    let monitor = w
        .monitor_from_point(x as f64, y as f64)
        .map_err(|e| e.to_string())?
        .or(w.primary_monitor().map_err(|e| e.to_string())?);
    if let Some(m) = monitor {
        let a = m.work_area();
        let scale = m.scale_factor();
        let width = (900.0 * scale).min(a.size.width as f64);
        let height = (540.0 * scale).min(a.size.height as f64);
        w.set_size(PhysicalSize::new(width as u32, height as u32))
            .map_err(|e| e.to_string())?;
        w.set_position(PhysicalPosition::new(
            a.position.x + (a.size.width as i32 - width as i32) / 2,
            a.position.y + (a.size.height as i32 - height as i32) / 2,
        ))
        .map_err(|e| e.to_string())?;
    }
    w.show().map_err(|e| e.to_string())?;
    quick_presence(app, true);
    w.set_focus().map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(false);
    let _ = w.emit("desktop-shown", serde_json::json!({"focus":true}));
    Ok(())
}
pub fn begin_capture(app: &tauri::AppHandle) -> Result<(), String> {
    if !app.state::<Desktop>().prefs.lock().unwrap().screenshot_enabled { return Err("截图功能已关闭".into()); }
    let desktop_state = app.state::<Desktop>();
    if desktop_state.capture_starting.swap(true, Ordering::SeqCst) { return Ok(()); }
    struct Starting<'a>(&'a AtomicBool);
    impl Drop for Starting<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
    let _starting = Starting(&desktop_state.capture_starting);
    if desktop_state.dialog_active.load(Ordering::SeqCst) { return Err("请先完成当前文件对话框，再重新截图".into()); }
    if desktop_state.capture.lock().unwrap().is_some() { return Ok(()); }
    let epoch = desktop_state.capture_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    crate::selection::dismiss(app);
    crate::pinned_menu::dismiss(app, false);
    let _ = app.emit_to("pet", "desktop-pet-hide-menu", ());
    let mut hidden = vec![];
    for w in app.webview_windows().values() {
        if (["pet", "quick", "pomodoro-timer"].contains(&w.label()) || w.label().starts_with("pin-"))
            && w.is_visible().unwrap_or(false)
        {
            if let Err(error) = w.hide() {
                *desktop_state.hidden.lock().unwrap() = hidden;
                restore_capture_windows(app);
                return Err(error.to_string());
            }
            hidden.push(w.label().to_owned());
            if w.label() == "quick" { quick_presence(app, false); }
        }
    }
    *app.state::<Desktop>().hidden.lock().unwrap() = hidden;
    let capture = match desktop_image() {
        Ok(c) => c,
        Err(error) => {
            restore_capture_windows(app);
            return if desktop_state.capture_epoch.load(Ordering::SeqCst) == epoch { Err(error) } else { Ok(()) };
        }
    };
    let (x, y, width, height) = (capture.x, capture.y, capture.width, capture.height);
    {
        let mut current = desktop_state.capture.lock().unwrap();
        if desktop_state.capture_epoch.load(Ordering::SeqCst) != epoch {
            drop(current);
            restore_capture_windows(app);
            return Ok(());
        }
        *current = Some(capture);
    }
    let result = (|| {
        let w = window(app, "capture", 900.0, 600.0)?;
        w.set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        w.set_size(PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        w.emit("capture-ready", ()).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        finish_capture(app, None);
    }
    result
}
#[tauri::command]
pub fn capture_present(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| c.id == id)
    {
        return Err("截图会话已结束".into());
    }
    let w = app.get_webview_window("capture").ok_or("截图窗口不可用")?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn capture_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let d = app.state::<Desktop>();
    let state = d.capture.lock().unwrap();
    let c = state.as_ref().ok_or("截图会话已结束")?;
    let (px, py) = crate::desktop_input::cursor();
    let monitor = app
        .get_webview_window("capture")
        .and_then(|w| w.monitor_from_point(px as f64, py as f64).ok().flatten());
    let area = monitor.as_ref().map(|m| m.work_area());
    Ok(
        serde_json::json!({"id":c.id,"width":c.width,"height":c.height,"x":c.x,"y":c.y,"cursorX":px-c.x,"cursorY":py-c.y,
        "monitorX":area.map(|a|a.position.x-c.x).unwrap_or(0),"monitorY":area.map(|a|a.position.y-c.y).unwrap_or(0),
        "monitorWidth":area.map(|a|a.size.width).unwrap_or(c.width),"monitorHeight":area.map(|a|a.size.height).unwrap_or(c.height)}),
    )
}
#[tauri::command]
pub fn capture_pixels(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let d = app.state::<Desktop>();
    let state = d.capture.lock().unwrap();
    let c = state
        .as_ref()
        .filter(|c| c.id == id)
        .ok_or("截图会话已结束")?;
    Ok(tauri::ipc::Response::new(c.pixels.clone()))
}
#[tauri::command]
pub fn capture_cancel(app: tauri::AppHandle, id: Option<String>) -> Result<bool, String> {
    Ok(finish_capture(&app, id.as_deref()))
}
#[tauri::command]
pub async fn capture_export(
    app: tauri::AppHandle,
    id: String,
    data_url: String,
    action: String,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<bool, String> {
    let _capture_exists = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .filter(|c| c.id == id)
        .map(|c| c.id.clone())
        .ok_or("截图会话已结束")?;
    let bytes = STANDARD
        .decode(
            data_url
                .strip_prefix("data:image/png;base64,")
                .ok_or("无效图片")?,
        )
        .map_err(|_| "无效图片")?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("截图过大，请缩小范围".into());
    }
    match action.as_str() {
        "save" => {
            let _dialog = NativeDialog::new(&app);
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_file_name("XiaoXi截图.png")
                .add_filter("PNG", &["png"]);
            if let Some(w) = app.get_webview_window("capture") {
                dialog = dialog.set_parent(&w);
            }
            let Some(file) = dialog.save_file().await else {
                return Ok(false);
            };
            if !app
                .state::<Desktop>()
                .capture
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|c| c.id == id)
            {
                return Ok(false);
            }
            std::fs::write(file.path(), &bytes).map_err(|e| e.to_string())?;
        }
        "copy" => {
            let img = image::load_from_memory(&bytes)
                .map_err(|_| "无效图片")?
                .into_rgba8();
            app.clipboard()
                .write_image(&tauri::image::Image::new_owned(
                    img.as_raw().clone(),
                    img.width(),
                    img.height(),
                ))
                .map_err(|e| e.to_string())?;
        }
        "pin" => {
            crate::pinned::create(&app, data_url.clone(), x.unwrap_or(0), y.unwrap_or(0))?;
        }
        "attach" | "ocr" | "translate" => {
            if !app
                .state::<Desktop>()
                .capture
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|c| c.id == id)
            {
                return Ok(false);
            }
            open_ai(app.clone())?;
            enqueue_quick(&app, QuickAction::Image { data_url, image_action: action });
            return Ok(true);
        }
        _ => return Err("未知截图操作".into()),
    }
    finish_capture(&app, Some(&id));
    Ok(true)
}
pub fn forget_pin(label: &str) {
    crate::pinned::forget(label);
}
#[tauri::command]
pub fn desktop_main(
    app: tauri::AppHandle,
    conversation_id: Option<String>,
    settings: Option<bool>,
    settings_tab: Option<String>,
    new_chat: Option<bool>,
    page: Option<String>,
) -> Result<(), String> {
    if page.as_ref().is_some_and(|value| !["pomodoro", "current", "plans", "notifications", "common-texts"].contains(&value.as_str())) {
        return Err("未知主窗口页面，请从主导航重新选择。".into());
    }
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    crate::window_layout::ensure_visible(&window).map_err(|e| e.to_string())?;
    crate::navigation::send(&app,
        serde_json::json!({"conversationId":conversation_id,"settings":settings.unwrap_or(false),"settingsTab":settings_tab,"newChat":new_chat.unwrap_or(false),"page":page}),
    )?;
    // The screenshot and answer surfaces are always on top. End them before
    // focusing main, including when opening an existing conversation.
    desktop_dismiss_label(&app, "quick");
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn desktop_pick_files(
    app: tauri::AppHandle,
) -> Result<Vec<crate::drop_files::DropFile>, String> {
    let _dialog = NativeDialog::new(&app);
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("添加文件")
        .add_filter(
            "支持的附件",
            &[
                "png", "jpg", "jpeg", "webp", "pdf", "docx", "xlsx", "txt", "md", "csv", "json",
            ],
        );
    if let Ok(folder) = app.path().desktop_dir() {
        dialog = dialog.set_directory(folder);
    }
    if let Some(w) = app.get_webview_window("quick") {
        dialog = dialog.set_parent(&w);
    }
    let Some(files) = dialog.pick_files().await else {
        return Ok(vec![]);
    };
    if files.len() > 4 {
        return Err("每次最多提交 4 个附件".into());
    }
    let paths: Vec<String> = files
        .iter()
        .map(|f| f.path().to_string_lossy().into_owned())
        .collect();
    app.state::<crate::drop_files::DroppedPaths>()
        .0
        .lock()
        .unwrap()
        .extend(files.iter().map(|f| f.path().to_path_buf()));
    crate::drop_files::read_dropped_files(app.state(), paths, false, Some(false)).await
}
pub(crate) struct NativeDialog(tauri::AppHandle);
impl NativeDialog {
    pub(crate) fn new(app: &tauri::AppHandle) -> Self {
        app.state::<Desktop>()
            .dialog_active
            .store(true, Ordering::SeqCst);
        Self(app.clone())
    }
}
impl Drop for NativeDialog {
    fn drop(&mut self) {
        self.0
            .state::<Desktop>()
            .dialog_active
            .store(false, Ordering::SeqCst);
    }
}
#[tauri::command]
pub fn desktop_pet_drag(app: tauri::AppHandle, window: tauri::WebviewWindow, drag_id: u64) -> Result<bool, String> {
    if window.label() != "pet" {
        return Err("仅桌宠可以使用这个操作".into());
    }
    if unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
            windows::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON.0 as i32,
        )
    } >= 0
    {
        return Ok(false);
    }
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    app.state::<Desktop>().pet_drag_id.store(drag_id, Ordering::SeqCst);
    app.state::<Desktop>().pet_dragging.store(true, Ordering::SeqCst);
    let _ = window.emit("desktop-pet-drag-started", serde_json::json!({"dragId":drag_id}));
    if let Err(e) = window.start_dragging() {
        app.state::<Desktop>()
            .pet_dragging
            .store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }
    Ok(true)
}
#[tauri::command]
pub fn desktop_hit_regions(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    regions: Vec<HitRegion>,
) -> Result<(), String> {
    if !["quick", "pet", "selection", "pomodoro-timer", "pin-menu"].contains(&window.label()) {
        return Ok(());
    }
    if regions.len() > 32
        || regions.iter().any(|r| {
            ![r.x, r.y, r.width, r.height, r.border_radius].iter().all(|v| v.is_finite())
                || r.width < 0.0
                || r.height < 0.0
                || r.border_radius < 0.0
        })
    {
        return Err("无效窗口区域".into());
    }
    app.state::<Desktop>()
        .hit_regions
        .lock()
        .unwrap()
        .insert(window.label().into(), regions.clone());
    apply_hit_regions(&window, &regions)
}
pub fn refresh_hit_regions(app: &tauri::AppHandle, label: &str) {
    let regions = app
        .state::<Desktop>()
        .hit_regions
        .lock()
        .unwrap()
        .get(label)
        .cloned();
    if let (Some(regions), Some(window)) = (regions, app.get_webview_window(label)) {
        let _ = apply_hit_regions(&window, &regions);
    }
}
fn apply_hit_regions(window: &tauri::WebviewWindow, regions: &[HitRegion]) -> Result<(), String> {
    // A transparent timer must not repeatedly repaint the native non-client
    // frame. It uses cursor passthrough without changing its paint region.
    if window.label() == "pomodoro-timer" {
        return crate::pomodoro::update_hit_test(window, regions).map(|_| ());
    }
    use windows::Win32::Graphics::Gdi::*;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let combined = CreateRectRgn(0, 0, 0, 0);
        if combined.0.is_null() {
            return Err("无法更新窗口交互区域".into());
        }
        for r in regions {
            let margin = if window.label() == "pet" { 2.0 } else { 6.0 };
            let piece = CreateRectRgn(
                ((r.x - margin) * scale).floor() as i32,
                ((r.y - margin) * scale).floor() as i32,
                ((r.x + r.width + margin) * scale).ceil() as i32,
                ((r.y + r.height + margin) * scale).ceil() as i32,
            );
            if piece.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(combined.0));
                return Err("无法更新窗口交互区域".into());
            }
            let result = CombineRgn(Some(combined), Some(combined), Some(piece), RGN_OR);
            let _ = DeleteObject(HGDIOBJ(piece.0));
            if result.0 == ERROR {
                let _ = DeleteObject(HGDIOBJ(combined.0));
                return Err("无法更新窗口交互区域".into());
            }
        }
        // Windows owns this region after success; both paint and native hit testing use the same geometry.
        if SetWindowRgn(
            windows::Win32::Foundation::HWND(hwnd.0),
            Some(combined),
            true,
        ) == 0
        {
            let _ = DeleteObject(HGDIOBJ(combined.0));
            return Err("无法更新窗口交互区域".into());
        }
    }
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn desktop_quick_state(app: tauri::AppHandle, session_id: String, busy: bool) {
    let state = app.state::<Desktop>();
    let session = state.ask_session.lock().unwrap();
    if *session != session_id {
        return;
    }
    state.quick_busy.store(busy, Ordering::Relaxed);
}
fn desktop_image() -> Result<Capture, String> {
    use windows::Win32::{
        Graphics::{Dwm::DwmFlush, Gdi::*},
        UI::WindowsAndMessaging::*,
    };
    unsafe {
        let _ = DwmFlush();
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 || width as u64 * height as u64 > 80_000_000 {
            return Err("屏幕尺寸超出支持范围".into());
        }
        let screen = GetDC(None);
        if screen.0.is_null() {
            return Err("无法读取桌面".into());
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.0.is_null() || bitmap.0.is_null() {
            let _ = DeleteDC(memory);
            let _ = ReleaseDC(None, screen);
            return Err("无法创建截图缓冲区".into());
        }
        let old = SelectObject(memory, HGDIOBJ(bitmap.0));
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            Some(screen),
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        );
        SelectObject(memory, old);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let rows = if copied.is_ok() {
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        let _ = ReleaseDC(None, screen);
        if rows != height {
            return Err("桌面截图失败".into());
        }
        for p in pixels.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
        }
        Ok(Capture {
            id: uuid::Uuid::new_v4().to_string(),
            pixels,
            width: width as u32,
            height: height as u32,
            x,
            y,
        })
    }
}
