//! A separate transparent host keeps themed menus outside pinned image bounds.
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuView {
    editing: bool,
    busy: bool,
    shadow: bool,
    opacity: f64,
    zoom_only: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSession {
    request_id: String,
    owner: String,
    revision: u64,
    width: u32,
    height: u32,
    scale: f64,
    editing: bool,
    busy: bool,
    shadow: bool,
    opacity: f64,
    zoom_only: bool,
    anchor_x: f64,
    anchor_y: f64,
    #[serde(skip)]
    presented: bool,
}
static SESSION: LazyLock<Mutex<Option<MenuSession>>> = LazyLock::new(|| Mutex::new(None));

pub fn dismiss(app: &tauri::AppHandle, restore_focus: bool) {
    let session = SESSION.lock().unwrap().take();
    if let Some(session) = session {
        if let Some(window) = app.get_webview_window("pin-menu") {
            let _ = window.emit("pinned-menu-closed", &session.request_id);
            let _ = window.hide();
        }
        if restore_focus {
            if let Some(owner) = app.get_webview_window(&session.owner) {
                if owner.is_visible().unwrap_or(false) {
                    let _ = owner.set_focus();
                }
            }
        }
    }
}
pub fn owner_closed(app: &tauri::AppHandle, label: &str) {
    let close = SESSION
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|session| session.owner == label || label == "pin-menu");
    if close {
        dismiss(app, false);
    }
}
pub fn focus_lost(app: &tauri::AppHandle) {
    let presented = SESSION
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|session| session.presented);
    if presented
        && app
            .get_webview_window("pin-menu")
            .is_some_and(|window| !window.is_focused().unwrap_or(false))
    {
        dismiss(app, false);
    }
}
#[tauri::command]
pub fn pinned_menu_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    x: f64,
    y: f64,
    view: MenuView,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&request_id).is_err()
        || ![x, y, view.opacity].iter().all(|n| n.is_finite())
    {
        return Err("无效贴图菜单请求".into());
    }
    let (width, height, scale, revision) = crate::pinned::menu_snapshot(&window)?;
    let owner_dpi = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let screen_x = position.x as f64 + (x * owner_dpi).clamp(0.0, size.width as f64);
    let screen_y = position.y as f64 + (y * owner_dpi).clamp(0.0, size.height as f64);
    let monitor = window
        .monitor_from_point(screen_x, screen_y)
        .map_err(|e| e.to_string())?
        .or(window.current_monitor().map_err(|e| e.to_string())?)
        .ok_or("显示器不可用")?;
    let area = monitor.work_area();
    let dpi = monitor.scale_factor();
    let host_width = (600.0 * dpi).min(area.size.width as f64).round() as u32;
    let host_height = (600.0 * dpi).min(area.size.height as f64).round() as u32;
    let left = ((screen_x - 10.0 * dpi).round() as i32).clamp(
        area.position.x,
        area.position.x + area.size.width.saturating_sub(host_width) as i32,
    );
    let top = ((screen_y - 10.0 * dpi).round() as i32).clamp(
        area.position.y,
        area.position.y + area.size.height.saturating_sub(host_height) as i32,
    );
    dismiss(&app, false);
    let popup = if let Some(popup) = app.get_webview_window("pin-menu") {
        popup
    } else {
        WebviewWindowBuilder::new(
            &app,
            "pin-menu",
            WebviewUrl::App("index.html?view=pin-menu".into()),
        )
        .title("XiaoXi · 贴图菜单")
        .inner_size(600.0, 600.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?
    };
    popup
        .set_position(PhysicalPosition::new(left, top))
        .map_err(|e| e.to_string())?;
    popup
        .set_size(PhysicalSize::new(host_width, host_height))
        .map_err(|e| e.to_string())?;
    let session = MenuSession {
        request_id,
        owner: window.label().into(),
        width,
        height,
        scale,
        revision,
        editing: view.editing,
        busy: view.busy,
        shadow: view.shadow,
        opacity: view.opacity.clamp(0.15, 1.0),
        zoom_only: view.zoom_only,
        anchor_x: (screen_x - left as f64) / dpi,
        anchor_y: (screen_y - top as f64) / dpi,
        presented: false,
    };
    *SESSION.lock().unwrap() = Some(session.clone());
    if let Err(error) = popup
        .emit("pinned-menu-open", &session)
        .and_then(|_| popup.show())
        .and_then(|_| popup.set_focus())
    {
        let matches = SESSION
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|current| current.request_id == session.request_id);
        if matches {
            dismiss(&app, false);
        }
        return Err(error.to_string());
    }
    if let Some(current) = SESSION
        .lock()
        .unwrap()
        .as_mut()
        .filter(|current| current.request_id == session.request_id)
    {
        current.presented = true;
    }
    Ok(())
}
#[tauri::command]
pub fn pinned_menu_get(window: tauri::WebviewWindow) -> Result<Option<MenuSession>, String> {
    if window.label() != "pin-menu" {
        return Err("仅菜单窗口可读取这个状态".into());
    }
    Ok(SESSION.lock().unwrap().clone())
}
#[tauri::command]
pub fn pinned_menu_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    restore_focus: bool,
) -> Result<(), String> {
    let allowed = SESSION.lock().unwrap().as_ref().is_some_and(|session| {
        session.request_id == request_id
            && (window.label() == "pin-menu" || window.label() == session.owner)
    });
    if allowed {
        dismiss(&app, restore_focus);
    }
    Ok(())
}
fn valid_action(action: &str) -> bool {
    if [
        "copy",
        "copy-original",
        "save",
        "annotate",
        "shadow",
        "paste",
        "replace",
        "close",
        "destroy",
        "copy-size",
        "rotate-left",
        "rotate-right",
        "flip-x",
        "flip-y",
        "grayscale",
        "invert",
        "reset-image",
    ]
    .contains(&action)
    {
        return true;
    }
    if let Some(value) = action
        .strip_prefix("zoom:")
        .and_then(|value| value.parse::<f64>().ok())
    {
        return value.is_finite() && (0.0..=4.0).contains(&value);
    }
    if let Some(value) = action
        .strip_prefix("opacity:")
        .and_then(|value| value.parse::<f64>().ok())
    {
        return value.is_finite() && (0.15..=1.0).contains(&value);
    }
    false
}
#[tauri::command]
pub fn pinned_menu_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    action: String,
) -> Result<(), String> {
    if window.label() != "pin-menu" || !valid_action(&action) {
        return Err("无效菜单操作".into());
    }
    let session = SESSION
        .lock()
        .unwrap()
        .as_ref()
        .filter(|session| session.request_id == request_id)
        .cloned()
        .ok_or("菜单已关闭")?;
    if !crate::pinned::is_current(&session.owner, session.revision) {
        dismiss(&app, false);
        return Err("图片已变化，请重新打开菜单".into());
    }
    dismiss(&app, true);
    app.emit_to(&session.owner, "pinned-menu-action", serde_json::json!({"requestId": session.request_id, "revision": session.revision, "action": action})).map_err(|e| e.to_string())
}
