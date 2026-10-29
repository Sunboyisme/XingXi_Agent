//! Native owner of desktop surfaces. Runtime data stays in the current app data directory.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
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
    pub pet_expanded: AtomicBool,
    pub quick_top: AtomicI32,
    pub capture: Mutex<Option<Capture>>,
    pub selection_id: Mutex<String>,
    pub hidden: Mutex<Vec<String>>,
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
    serde_json::json!({"preferences":d.prefs.lock().unwrap().clone(),"ownsShortcuts":d.owned.load(Ordering::Relaxed)})
}
#[tauri::command]
pub fn desktop_preferences_save(
    app: tauri::AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    crate::desktop_input::parse_shortcut(&preferences.shortcut)?;
    std::fs::write(
        path(&app),
        serde_json::to_vec_pretty(&preferences).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    *app.state::<Desktop>().prefs.lock().unwrap() = preferences.clone();
    if let Some(pet) = app.get_webview_window("pet") {
        if preferences.pet
            && preferences.enabled
            && app.state::<Desktop>().owned.load(Ordering::Relaxed)
        {
            let _ = pet.show();
        } else {
            let _ = pet.hide();
        }
    }
    let _ = app.emit("desktop-preferences", preferences);
    Ok(())
}
pub fn restore(app: &tauri::AppHandle) {
    app.state::<Desktop>().capture.lock().unwrap().take();
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
    for label in std::mem::take(&mut *app.state::<Desktop>().hidden.lock().unwrap()) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
        }
    }
}
#[tauri::command]
pub fn desktop_open(app: tauri::AppHandle, capture: bool) -> Result<(), String> {
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
    Ok(())
}
pub fn begin_capture(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<Desktop>().capture.lock().unwrap().is_some() {
        return Ok(());
    }
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
    let capture = match desktop_image() {
        Ok(c) => c,
        Err(e) => {
            restore(app);
            return Err(e);
        }
    };
    let (x, y, width, height) = (capture.x, capture.y, capture.width, capture.height);
    *app.state::<Desktop>().capture.lock().unwrap() = Some(capture);
    let w = window(app, "capture", 900.0, 600.0)?;
    w.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let _ = w.emit("capture-ready", ());
    Ok(())
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
pub fn capture_cancel(app: tauri::AppHandle) -> Result<(), String> {
    restore(&app);
    desktop_open(app, false)
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
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_file_name("XiaoXi截图.png")
                .add_filter("PNG", &["png"])
                .save_file()
                .await
            else {
                return Ok(false);
            };
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
            restore(&app);
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
    restore(&app);
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
#[tauri::command]
pub fn desktop_selection_offer(app: tauri::AppHandle, text: String) {
    crate::desktop_input::offer_dom(&app, text);
}
#[tauri::command]
pub fn desktop_pet_interactive(app: tauri::AppHandle, expanded: bool) {
    app.state::<Desktop>()
        .pet_expanded
        .store(expanded, Ordering::Relaxed);
}
#[tauri::command]
pub fn desktop_quick_top(app: tauri::AppHandle, top: f64) {
    app.state::<Desktop>()
        .quick_top
        .store(top.max(0.0).round() as i32, Ordering::Relaxed);
}
pub fn offer_selection(app: &tauri::AppHandle, text: String, error: Option<String>) {
    let id = uuid::Uuid::new_v4().to_string();
    *app.state::<Desktop>().selection_id.lock().unwrap() = id.clone();
    let _ = app.emit_to(
        "selection",
        "desktop-selection",
        serde_json::json!({"id":id,"text":text,"error":error}),
    );
    if let Some(w) = app.get_webview_window("selection") {
        let (x, y) = crate::desktop_input::cursor();
        let _ = w.set_position(PhysicalPosition::new(x - 120, y + 20));
        let _ = crate::window_layout::ensure_visible(&w);
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
        })
    }
}
