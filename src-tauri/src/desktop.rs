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

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub pet: bool,
    pub pomodoro: bool,
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
    pub pet: Option<bool>,
    pub pomodoro: Option<bool>,
    pub pet_size: Option<u16>,
    pub selection_enabled: Option<bool>,
    pub selection_shortcut: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    id: String,
    session_id: String,
    action: String,
    text: Option<String>,
    data_url: Option<String>,
    gesture: Option<u64>,
    image_action: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            pet: true,
            pomodoro: true,
            pet_x: None,
            pet_y: None,
            pet_size: 100,
            pet_offset_x: None,
            pet_offset_y: None,
            selection_enabled: true,
            selection_shortcut: "Ctrl+Shift+E".into(),
        }
    }
}
#[derive(Default)]
pub struct Desktop {
    pub prefs: Mutex<Preferences>,
    pub owned: AtomicBool,
    pub pet_dragging: AtomicBool,
    pub pet_drag_id: AtomicU64,
    pub pet_visibility_epoch: AtomicU64,
    pub pet_exiting: AtomicBool,
    pub quick_text: Mutex<String>,
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
    pub draft_text: String,
    pub session_id: String,
    pub composer_rect: Option<tauri::PhysicalRect<i32, u32>>,
    pub selecting: bool,
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
        let size = pet.outer_size().map_err(|e| e.to_string())?;
        let x = p
            .pet_x
            .unwrap_or(area.position.x + area.size.width as i32 - size.width as i32 - 24);
        let y = p
            .pet_y
            .unwrap_or(area.position.y + area.size.height as i32 - size.height as i32 - 24);
        pet.set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        let _ = place_pet(app, false);
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
    if let Some(v) = preferences.pet {
        next.pet = v;
    }
    if let Some(v) = preferences.pomodoro {
        next.pomodoro = v;
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
        // place the avatar, rather than the transparent window frame, at the corner.
        let gap = (24.0 * target_scale).round() as i32;
        let x = (a.position.x + a.size.width as i32 - target_diameter - gap).max(a.position.x);
        let y = (a.position.y + a.size.height as i32 - target_diameter - gap - (72.0 * target_scale).round() as i32).max(a.position.y);
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
    let _ = crate::pomodoro::place_widget(app);
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
    if !shown { crate::pomodoro::refresh_visibility(app); }
    if shown {
        if state.capture.lock().unwrap().is_some() {
            let mut hidden = state.hidden.lock().unwrap();
            if !hidden.iter().any(|label| label == "pet") {
                hidden.push("pet".into());
            }
            return;
        }
        let _ = w.show();
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
fn finish_capture(app: &tauri::AppHandle, id: Option<&str>) -> bool {
    let state = app.state::<Desktop>();
    let capture = {
        let mut c = state.capture.lock().unwrap();
        if id.is_some_and(|id| !c.as_ref().is_some_and(|v| v.id == id)) {
            return false;
        }
        c.take()
    };
    let Some(capture) = capture else {
        return false;
    };
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.emit("capture-dismiss", &capture.id);
        let _ = w.hide();
    }
    let hidden = std::mem::take(&mut *app.state::<Desktop>().hidden.lock().unwrap());
    for label in hidden {
        if label == "pomodoro-timer" { crate::pomodoro::refresh_visibility(app); continue; }
        if label == "quick" {
            continue;
        }
        if label == "pet" && !state.prefs.lock().unwrap().pet {
            continue;
        }
        if label == "pet" {
            set_pet_visible(app, true);
            continue;
        }
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
        }
    }
    true
}
pub fn desktop_dismiss_label(app: &tauri::AppHandle, label: &str) {
    if label == "pomodoro-timer" { crate::pomodoro::hide_widget(app); return; }
    if label == "selection" { crate::selection::dismiss(app); return; }
    if label == "capture" {
        let selection = app
            .state::<Desktop>()
            .capture
            .lock()
            .unwrap()
            .as_ref()
            .filter(|c| c.selecting)
            .map(|c| c.id.clone());
        if let Some(id) = selection {
            let _ = capture_cancel(app.clone(), Some(id));
            return;
        }
        finish_capture(app, None);
        desktop_dismiss_label(app, "quick");
        return;
    }
    if label == "quick" {
        finish_capture(app, None);
        crate::voice::cancel_owner(&app, "quick");
        app.state::<Desktop>()
            .quick_commands
            .lock()
            .unwrap()
            .retain(|command| command.action == "send" || command.action == "image");
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
#[tauri::command]
pub fn desktop_toggle(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if app.state::<Desktop>().capture.lock().unwrap().is_some() {
        desktop_dismiss_label(&app, "capture");
        return Ok(());
    }
    if app
        .get_webview_window("quick")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        desktop_dismiss_label(&app, "quick");
        return Ok(());
    }
    desktop_open(app, true)
}
pub fn begin_ask_session(app: &tauri::AppHandle) -> Result<String, String> {
    finish_capture(app, None);
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
        quick_presence(app, w.is_visible().unwrap_or(false));
    }
    crate::voice::cancel_owner(&app, "quick");
    let id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<Desktop>();
    let mut session = state.ask_session.lock().unwrap();
    *session = id.clone();
    state.quick_commands.lock().unwrap().clear();
    state.quick_busy.store(false, Ordering::SeqCst);
    state.quick_text.lock().unwrap().clear();
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
pub fn enqueue_quick(
    app: &tauri::AppHandle,
    action: &str,
    text: Option<String>,
    data_url: Option<String>,
    gesture: Option<u64>,
    image_action: Option<String>,
) {
    let state = app.state::<Desktop>();
    let session = state.ask_session.lock().unwrap();
    let session_id = session.clone();
    state.quick_commands.lock().unwrap().push(QuickCommand {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        action: action.into(),
        text,
        data_url,
        gesture,
        image_action,
    });
    drop(session);
    let _ = app.emit_to(
        "quick",
        "desktop-command",
        serde_json::json!({"sessionId":session_id}),
    );
}
#[tauri::command]
pub fn desktop_open(app: tauri::AppHandle, capture: bool) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if capture {
        begin_ask_session(&app)?;
        return begin_capture(&app);
    }
    let active_capture = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.id.clone());
    if let Some(id) = active_capture {
        let _ = app.emit_to("capture", "capture-reset", id);
        return show_capture_composer(&app);
    }
    if begin_capture(&app).is_ok() {
        return Ok(());
    }
    // Keep error feedback available if the desktop cannot be captured.
    show_quick_window(&app)
}
pub fn desktop_record(app: tauri::AppHandle) -> Result<(), String> {
    desktop_open(app, false)
}
#[tauri::command]
pub fn desktop_resume(app: tauri::AppHandle, run_id: Option<String>) -> Result<(), String> {
    desktop_start(app.clone(), Some(false), Some(false))?;
    if let Some(id) = run_id {
        app.emit_to("quick", "desktop-resume-task", serde_json::json!({"runId":id}))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_start(app: tauri::AppHandle, new_chat: Option<bool>, voice: Option<bool>) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if new_chat.unwrap_or(false) || app.state::<Desktop>().ask_session.lock().unwrap().is_empty() {
        begin_ask_session(&app)?;
    }
    desktop_open(app.clone(), false)?;
    if voice.unwrap_or(false) {
        // Open the editor first. Its current run/upload/recording state decides
        // whether to start recording; a cached busy flag must not block reopening.
        enqueue_quick(&app, "voice", None, None, None, None);
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
    let _ = w.emit("desktop-shown", ());
    Ok(())
}
fn capture_composer_rect(app: &tauri::AppHandle) -> Result<tauri::PhysicalRect<i32, u32>, String> {
    let w = app.get_webview_window("quick").ok_or("问答窗口不可用")?;
    let (x, y) = crate::desktop_input::cursor();
    let monitor = w
        .monitor_from_point(x as f64, y as f64)
        .map_err(|e| e.to_string())?
        .or(w.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("显示器不可用")?;
    let a = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (884.0 * scale).min(a.size.width as f64) as u32;
    let bottom = (a.position.y as f64 + a.size.height as f64 * 0.65 + 96.0 * scale)
        .min((a.position.y + a.size.height as i32) as f64);
    let height = (540.0 * scale)
        .min(bottom - a.position.y as f64)
        .max(96.0 * scale) as u32;
    Ok(tauri::PhysicalRect {
        position: PhysicalPosition::new(
            a.position.x + (a.size.width as i32 - width as i32) / 2,
            bottom as i32 - height as i32,
        ),
        size: PhysicalSize::new(width, height),
    })
}
fn show_capture_composer(app: &tauri::AppHandle) -> Result<(), String> {
    let rect = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|c| {
            c.selecting = false;
            c.composer_rect
        })
        .ok_or("截图会话已结束")?;
    let w = app.get_webview_window("quick").ok_or("问答窗口不可用")?;
    w.set_position(rect.position).map_err(|e| e.to_string())?;
    w.set_size(rect.size).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    quick_presence(app, true);
    w.set_focus().map_err(|e| e.to_string())?;
    let _ = w.emit("desktop-shown", ());
    Ok(())
}
pub fn begin_capture(app: &tauri::AppHandle) -> Result<(), String> {
    crate::selection::dismiss(app);
    crate::pinned_menu::dismiss(app, false);
    if app.state::<Desktop>().capture.lock().unwrap().is_some() {
        return Ok(());
    }
    let composer_rect = capture_composer_rect(app)?;
    let _ = app.emit_to("pet", "desktop-pet-hide-menu", ());
    let mut hidden = vec![];
    for w in app.webview_windows().values() {
        if ["pet", "quick", "pomodoro-timer"].contains(&w.label()) || w.label().starts_with("pin-") {
            if w.is_visible().unwrap_or(false) {
                hidden.push(w.label().to_owned());
                w.hide().map_err(|e| e.to_string())?;
                if w.label() == "quick" { quick_presence(app, false); }
            }
        }
    }
    *app.state::<Desktop>().hidden.lock().unwrap() = hidden;
    let mut capture = match desktop_image() {
        Ok(c) => c,
        Err(e) => {
            let hidden = std::mem::take(&mut *app.state::<Desktop>().hidden.lock().unwrap());
            for label in hidden {
                if label == "pomodoro-timer" { crate::pomodoro::refresh_visibility(app); continue; }
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.show();
                    if label == "quick" { quick_presence(app, true); }
                }
            }
            return Err(e);
        }
    };
    capture.session_id = app.state::<Desktop>().ask_session.lock().unwrap().clone();
    capture.composer_rect = Some(composer_rect);
    capture.draft_text = app.state::<Desktop>().quick_text.lock().unwrap().clone();
    let (x, y, width, height) = (capture.x, capture.y, capture.width, capture.height);
    *app.state::<Desktop>().capture.lock().unwrap() = Some(capture);
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
    show_capture_composer(&app)
}
#[tauri::command]
pub fn capture_select(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let session_id = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_mut()
        .filter(|c| c.id == id)
        .map(|c| {
            c.selecting = true;
            c.session_id.clone()
        })
        .ok_or("截图会话已结束")?;
    crate::voice::cancel_owner(&app, "quick");
    let _ = app.emit_to(
        "quick",
        "desktop-hidden",
        serde_json::json!({"sessionId":session_id}),
    );
    if let Some(w) = app.get_webview_window("quick") {
        w.hide().map_err(|e| e.to_string())?;
        quick_presence(&app, false);
    }
    Ok(())
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
        serde_json::json!({"id":c.id,"width":c.width,"height":c.height,"x":c.x,"y":c.y,"cursorX":px-c.x,"cursorY":py-c.y,"draftText":c.draft_text,
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
    let current = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| id.as_ref().is_none_or(|id| c.id == *id));
    if !current {
        return Ok(false);
    }
    desktop_open(app, false)?;
    Ok(true)
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
    let draft_text = app
        .state::<Desktop>()
        .capture
        .lock()
        .unwrap()
        .as_ref()
        .filter(|c| c.id == id)
        .map(|c| c.draft_text.clone())
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
            desktop_open(app.clone(), false)?;
            enqueue_quick(
                &app,
                "image",
                Some(draft_text),
                Some(data_url),
                None,
                Some(action),
            );
            return Ok(true);
        }
        _ => return Err("未知截图操作".into()),
    }
    if finish_capture(&app, Some(&id)) {
        desktop_dismiss_label(&app, "quick");
    }
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
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    crate::window_layout::ensure_visible(&window).map_err(|e| e.to_string())?;
    app.emit_to(
        "main",
        "desktop-navigate",
        serde_json::json!({"conversationId":conversation_id,"settings":settings.unwrap_or(false),"settingsTab":settings_tab,"newChat":new_chat.unwrap_or(false),"page":page.filter(|value| value == "pomodoro" || value == "current")}),
    ).map_err(|e| e.to_string())?;
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
pub fn desktop_quick_state(app: tauri::AppHandle, session_id: String, text: String, busy: bool) {
    let state = app.state::<Desktop>();
    let session = state.ask_session.lock().unwrap();
    if *session != session_id {
        return;
    }
    *state.quick_text.lock().unwrap() = text.clone();
    if let Some(c) = state
        .capture
        .lock()
        .unwrap()
        .as_mut()
        .filter(|c| c.session_id == session_id)
    {
        c.draft_text = text;
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
            draft_text: String::new(),
            session_id: String::new(),
            composer_rect: None,
            selecting: false,
        })
    }
}
