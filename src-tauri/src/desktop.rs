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
    pub selection: bool,
    pub shortcut: String,
    pub pet_x: Option<i32>,
    pub pet_y: Option<i32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencePatch {
    pub enabled: Option<bool>,
    pub pet: Option<bool>,
    pub selection: Option<bool>,
    pub shortcut: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct SelectionSnapshot {
    pub id: String,
    pub text: String,
    pub error: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct HitRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            pet: true,
            selection: true,
            shortcut: "Ctrl+Shift+E".into(),
            pet_x: None,
            pet_y: None,
        }
    }
}
#[derive(Default)]
pub struct Desktop {
    pub prefs: Mutex<Preferences>,
    pub owned: AtomicBool,
    pub pet_dragging: AtomicBool,
    pub shortcut_recording: AtomicBool,
    pub shortcut_error: Mutex<String>,
    pub quick_text: Mutex<String>,
    pub quick_busy: AtomicBool,
    pub dialog_active: AtomicBool,
    pub compose_sequence: AtomicU64,
    pub hit_regions: Mutex<std::collections::HashMap<String, Vec<HitRegion>>>,
    pub capture: Mutex<Option<Capture>>,
    pub selection: Mutex<Option<SelectionSnapshot>>,
    pub hidden: Mutex<Vec<String>>,
}
pub struct Capture {
    pub id: String,
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub draft_text: String,
    pub return_quick: bool,
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
        if let Ok(p) = serde_json::from_slice(&bytes) {
            *app.state::<Desktop>().prefs.lock().unwrap() = p;
        }
    }
    window(app, "quick", 900.0, 540.0)?;
    window(app, "capture", 900.0, 600.0)?;
    window(app, "selection", 560.0, 360.0)?;
    let pet = window(app, "pet", 340.0, 220.0)?;
    let p = app.state::<Desktop>().prefs.lock().unwrap().clone();
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
        let _ = crate::window_layout::ensure_visible(&pet);
    }
    crate::desktop_input::start(app.clone());
    Ok(())
}
#[tauri::command]
pub fn desktop_preferences(app: tauri::AppHandle) -> serde_json::Value {
    let d = app.state::<Desktop>();
    serde_json::json!({"preferences":d.prefs.lock().unwrap().clone(),"ownsShortcuts":d.owned.load(Ordering::Relaxed),"shortcutError":d.shortcut_error.lock().unwrap().clone()})
}
#[tauri::command]
pub async fn desktop_preferences_save(
    app: tauri::AppHandle,
    preferences: PreferencePatch,
) -> Result<serde_json::Value, String> {
    let _save = PREFERENCE_SAVE_LOCK.lock().await;
    let mut next = app.state::<Desktop>().prefs.lock().unwrap().clone();
    if let Some(v) = preferences.enabled {
        next.enabled = v;
    }
    if let Some(v) = preferences.pet {
        next.pet = v;
    }
    if let Some(v) = preferences.selection {
        next.selection = v;
    }
    if let Some(v) = preferences.shortcut {
        next.shortcut = v;
    }
    let preferences = next;
    crate::desktop_input::parse_shortcut(&preferences.shortcut)?;
    let config = preferences.clone();
    tauri::async_runtime::spawn_blocking(move || crate::desktop_input::configure_shortcut(config))
        .await
        .map_err(|e| e.to_string())??;
    let state = app.state::<Desktop>();
    let persisted = {
        let mut current = state.prefs.lock().unwrap();
        let mut next = preferences.clone();
        next.pet_x = current.pet_x;
        next.pet_y = current.pet_y;
        let result = persist_preferences(&app, &next);
        if result.is_ok() {
            *current = next;
        }
        result
    };
    if let Err(error) = persisted {
        let previous = state.prefs.lock().unwrap().clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            crate::desktop_input::configure_shortcut(previous)
        })
        .await;
        return Err(error);
    }
    if let Some(pet) = app.get_webview_window("pet") {
        if preferences.pet && app.state::<Desktop>().owned.load(Ordering::Relaxed) {
            let _ = pet.show();
        } else {
            let _ = pet.hide();
        }
    }
    if !preferences.enabled {
        finish_capture(&app, None, false);
        desktop_dismiss_label(&app, "quick");
    }
    if !preferences.selection {
        desktop_selection_dismiss(app.clone(), None);
    }
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
pub fn persist_pet_position(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        if let Ok(pos) = w.outer_position() {
            let state = app.state::<Desktop>();
            let mut p = state.prefs.lock().unwrap();
            p.pet_x = Some(pos.x);
            p.pet_y = Some(pos.y);
            let _ = persist_preferences(app, &p);
        }
    }
}
pub fn restore(app: &tauri::AppHandle) {
    finish_capture(app, None, false);
}
fn finish_capture(app: &tauri::AppHandle, id: Option<&str>, return_to_quick: bool) -> bool {
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
    for label in std::mem::take(&mut *app.state::<Desktop>().hidden.lock().unwrap()) {
        if label == "selection" || label == "quick" {
            continue;
        }
        if label == "pet" && !state.prefs.lock().unwrap().pet {
            continue;
        }
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
        }
    }
    if return_to_quick && capture.return_quick {
        let _ = desktop_open(app.clone(), false);
    }
    true
}
pub fn desktop_dismiss_label(app: &tauri::AppHandle, label: &str) {
    if label == "capture" {
        let _ = capture_cancel(app.clone(), None, None);
        return;
    }
    if label == "selection" {
        desktop_selection_dismiss(app.clone(), None);
        return;
    }
    if label == "quick" {
        crate::voice::voice_cancel(app.state(), None);
        let _ = app.emit_to("quick", "desktop-hidden", ());
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
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
        return capture_cancel(app, None, None).map(|_| ());
    }
    if app
        .get_webview_window("quick")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        desktop_dismiss_label(&app, "quick");
        return Ok(());
    }
    begin_capture(&app)
}
#[tauri::command]
pub fn desktop_open(app: tauri::AppHandle, capture: bool) -> Result<(), String> {
    if app.state::<Desktop>().dialog_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if capture {
        return begin_capture(&app);
    }
    restore(&app);
    let w = window(&app, "quick", 900.0, 540.0)?;
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
    w.set_focus().map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(false);
    let _ = w.emit("desktop-shown", ());
    Ok(())
}
pub fn begin_capture(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().capture.lock().unwrap().is_some() {
        return Ok(());
    }
    if app.state::<Desktop>().quick_busy.load(Ordering::Relaxed) {
        return desktop_open(app.clone(), false);
    }
    desktop_selection_dismiss(app.clone(), None);
    let _ = app.emit_to("pet", "desktop-pet-hide-menu", ());
    let mut hidden = vec![];
    for w in app.webview_windows().values() {
        if ["pet", "quick", "selection"].contains(&w.label()) || w.label().starts_with("pin-") {
            if w.is_visible().unwrap_or(false) {
                hidden.push(w.label().to_owned());
                w.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    *app.state::<Desktop>().hidden.lock().unwrap() = hidden;
    let mut capture = match desktop_image() {
        Ok(c) => c,
        Err(e) => {
            for label in std::mem::take(&mut *app.state::<Desktop>().hidden.lock().unwrap()) {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.show();
                }
            }
            return Err(e);
        }
    };
    capture.return_quick = app
        .state::<Desktop>()
        .hidden
        .lock()
        .unwrap()
        .iter()
        .any(|label| label == "quick");
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
        finish_capture(app, None, true);
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
pub fn capture_cancel(
    app: tauri::AppHandle,
    id: Option<String>,
    text: Option<String>,
) -> Result<bool, String> {
    if let Some(text) = text {
        if let Some(key) = id.as_ref() {
            capture_compose(app.clone(), key.clone(), text)?;
        }
    }
    Ok(finish_capture(&app, id.as_deref(), true))
}
#[tauri::command]
pub fn capture_compose(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    let state = app.state::<Desktop>();
    {
        let mut c = state.capture.lock().unwrap();
        let c = c.as_mut().filter(|c| c.id == id).ok_or("截图会话已结束")?;
        c.draft_text = text.clone();
    }
    *state.quick_text.lock().unwrap() = text.clone();
    let sequence = state.compose_sequence.fetch_add(1, Ordering::SeqCst) + 1;
    app.emit_to(
        "quick",
        "desktop-compose",
        serde_json::json!({"text":text,"sequence":sequence}),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn capture_continue(
    app: tauri::AppHandle,
    id: String,
    text: String,
    action: String,
) -> Result<(), String> {
    capture_compose(app.clone(), id.clone(), text)?;
    if !finish_capture(&app, Some(&id), false) {
        return Ok(());
    }
    desktop_open(app.clone(), false)?;
    app.emit_to(
        "quick",
        match action.as_str() {
            "send" => "desktop-submit",
            "file" => "desktop-pick",
            "voice" => "desktop-record-click",
            _ => return Err("未知问答操作".into()),
        },
        (),
    )
    .map_err(|e| e.to_string())
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
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_file_name("XiaoXi截图.png")
                .add_filter("PNG", &["png"])
                .save_file()
                .await
            else {
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
            let img = image::load_from_memory(&bytes).map_err(|_| "无效图片")?;
            let label = format!("pin-{}", uuid::Uuid::new_v4());
            PIN_IMAGES
                .lock()
                .unwrap()
                .insert(label.clone(), data_url.clone());
            let w = window(&app, &label, img.width() as f64, img.height() as f64)?;
            // Data is passed as an event after the new webview has mounted, via native state.
            w.set_position(PhysicalPosition::new(x.unwrap_or(0), y.unwrap_or(0)))
                .map_err(|e| e.to_string())?;
            let mut factor = 1.0f64;
            if let Ok(Some(m)) = w.current_monitor() {
                factor = factor
                    .min(m.work_area().size.width as f64 * 0.9 / img.width() as f64)
                    .min(m.work_area().size.height as f64 * 0.9 / img.height() as f64);
            }
            w.set_size(PhysicalSize::new(
                (img.width() as f64 * factor) as u32,
                (img.height() as f64 * factor) as u32,
            ))
            .map_err(|e| e.to_string())?;
            let _ = w.set_focusable(false);
            w.show().map_err(|e| e.to_string())?;
        }
        "attach" | "ocr" | "translate" => {
            if !finish_capture(&app, Some(&id), false) {
                return Ok(false);
            }
            desktop_open(app.clone(), false)?;
            app.emit_to(
                "quick",
                "desktop-image",
                serde_json::json!({"id":id,"dataUrl":data_url,"action":action}),
            )
            .map_err(|e| e.to_string())?;
            return Ok(true);
        }
        _ => return Err("未知截图操作".into()),
    }
    finish_capture(&app, Some(&id), true);
    Ok(true)
}
static PIN_IMAGES: std::sync::LazyLock<Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Default::default()));
#[tauri::command]
pub fn pinned_image(window: tauri::WebviewWindow) -> Option<String> {
    PIN_IMAGES.lock().unwrap().get(window.label()).cloned()
}
pub fn forget_pin(label: &str) {
    PIN_IMAGES.lock().unwrap().remove(label);
}
#[tauri::command]
pub fn desktop_main(
    app: tauri::AppHandle,
    conversation_id: Option<String>,
    settings: Option<bool>,
) {
    crate::open_main(&app);
    let _ = app.emit_to(
        "main",
        "desktop-navigate",
        serde_json::json!({"conversationId":conversation_id,"settings":settings.unwrap_or(false)}),
    );
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
struct NativeDialog(tauri::AppHandle);
impl NativeDialog {
    fn new(app: &tauri::AppHandle) -> Self {
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
pub fn desktop_selection_offer(
    window: tauri::WebviewWindow,
    text: String,
    request_id: Option<String>,
) {
    crate::desktop_input::offer_dom(window.label().to_string(), text, request_id);
}
#[tauri::command]
pub fn desktop_pet_drag(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅桌宠可以使用这个操作".into());
    }
    if unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
            windows::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON.0 as i32,
        )
    } >= 0
    {
        return Ok(());
    }
    app.state::<Desktop>()
        .pet_dragging
        .store(true, Ordering::SeqCst);
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    if let Err(e) = window.start_dragging() {
        app.state::<Desktop>()
            .pet_dragging
            .store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_hit_regions(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    regions: Vec<HitRegion>,
) -> Result<(), String> {
    if !["quick", "pet"].contains(&window.label()) {
        return Ok(());
    }
    if regions.len() > 32
        || regions.iter().any(|r| {
            ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
                || r.width < 0.0
                || r.height < 0.0
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
pub fn desktop_quick_state(app: tauri::AppHandle, text: String, busy: bool) {
    *app.state::<Desktop>().quick_text.lock().unwrap() = text;
    app.state::<Desktop>()
        .quick_busy
        .store(busy, Ordering::Relaxed);
}
#[tauri::command]
pub fn desktop_selection_get(app: tauri::AppHandle) -> Option<SelectionSnapshot> {
    app.state::<Desktop>().selection.lock().unwrap().clone()
}
#[tauri::command]
pub fn desktop_selection_dismiss(app: tauri::AppHandle, id: Option<String>) {
    let state = app.state::<Desktop>();
    let mut selection = state.selection.lock().unwrap();
    if id
        .as_ref()
        .is_some_and(|id| !selection.as_ref().is_some_and(|s| s.id == *id))
    {
        return;
    }
    crate::desktop_input::invalidate_selection();
    selection.take();
    drop(selection);
    if let Some(w) = app.get_webview_window("selection") {
        let _ = w.emit("desktop-selection-close", ());
        let _ = w.hide();
    }
}
pub fn place_surface(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let monitor = window
        .monitor_from_point(x as f64, y as f64)
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?);
    if let Some(m) = monitor {
        let a = m.work_area();
        let scale = m.scale_factor();
        let width = (width * scale).min(a.size.width as f64 - 16.0).max(1.0) as u32;
        let height = (height * scale).min(a.size.height as f64 - 16.0).max(1.0) as u32;
        window
            .set_size(PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        let left = (x - ((120.0 * scale) as i32)).clamp(
            a.position.x + 8,
            a.position.x + a.size.width as i32 - width as i32 - 8,
        );
        let top = (y + (16.0 * scale) as i32).clamp(
            a.position.y + 8,
            a.position.y + a.size.height as i32 - height as i32 - 8,
        );
        window
            .set_position(PhysicalPosition::new(left, top))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_selection_expand(
    app: tauri::AppHandle,
    id: String,
    expanded: bool,
) -> Result<(), String> {
    if !app
        .state::<Desktop>()
        .selection
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.id == id)
    {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("selection") {
        let pos = w.outer_position().map_err(|e| e.to_string())?;
        let scale = w.scale_factor().map_err(|e| e.to_string())?;
        place_surface(
            &w,
            pos.x + (120.0 * scale) as i32,
            pos.y - (16.0 * scale) as i32,
            if expanded { 560.0 } else { 420.0 },
            if expanded { 400.0 } else { 64.0 },
        )?;
    }
    Ok(())
}
pub fn offer_selection(app: &tauri::AppHandle, text: String, error: Option<String>) {
    let id = uuid::Uuid::new_v4().to_string();
    let snapshot = SelectionSnapshot { id, text, error };
    *app.state::<Desktop>().selection.lock().unwrap() = Some(snapshot.clone());
    let _ = app.emit_to("selection", "desktop-selection", &snapshot);
    if let Some(w) = app.get_webview_window("selection") {
        let (x, y) = crate::desktop_input::cursor();
        let issue = snapshot.error.is_some() || snapshot.text.len() > 20000;
        let _ = place_surface(
            &w,
            x,
            y,
            if issue { 560.0 } else { 420.0 },
            if issue { 230.0 } else { 64.0 },
        );
        let _ = w.show();
        let _ = w.set_focus();
    }
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
            return_quick: false,
        })
    }
}
