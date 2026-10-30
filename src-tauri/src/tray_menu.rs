//! A themed tray popup, without the native menu's reserved icon gutter.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

static GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    generation: u64,
    active: bool,
    pet: bool,
    pomodoro_visible: bool,
    preview: bool,
    autostart: crate::AutostartState,
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App("index.html?view=tray-menu".into()),
    )
    .title("XiaoXi · 托盘菜单")
    .inner_size(270.0, 434.0)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn dismiss(app: &tauri::AppHandle) {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("tray-menu") {
        let _ = window.hide();
    }
}

pub fn show(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("tray-menu")
        .ok_or("托盘菜单不可用")?;
    let monitor = window
        .monitor_from_point(x, y)
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or("显示器不可用")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (270.0 * scale).round().min(area.size.width as f64) as u32;
    let height = (510.0 * scale).round().min(area.size.height as f64) as u32;
    let left = (x.round() as i32 - width as i32 / 2).clamp(
        area.position.x,
        area.position.x + area.size.width.saturating_sub(width) as i32,
    );
    let top = (y.round() as i32 - height as i32 + (8.0 * scale).round() as i32).clamp(
        area.position.y,
        area.position.y + area.size.height.saturating_sub(height) as i32,
    );
    GENERATION.fetch_add(1, Ordering::SeqCst);
    ACTIVE.store(true, Ordering::SeqCst);
    let result = window
        .set_position(PhysicalPosition::new(left, top))
        .and_then(|_| window.set_size(PhysicalSize::new(width, height)))
        .and_then(|_| window.emit("tray-menu-open", GENERATION.load(Ordering::SeqCst)))
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus());
    if let Err(error) = result {
        dismiss(app);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn focus_lost(app: &tauri::AppHandle) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    // Initial Windows activation can briefly report a focus loss before focusing.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if GENERATION.load(Ordering::SeqCst) == generation
            && ACTIVE.load(Ordering::SeqCst)
            && app
                .get_webview_window("tray-menu")
                .is_some_and(|window| !window.is_focused().unwrap_or(false))
        {
            dismiss(&app);
        }
    });
}

#[tauri::command]
pub fn tray_menu_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<TrayState, String> {
    if window.label() != "tray-menu" {
        return Err("无效托盘菜单窗口".into());
    }
    let pet = app
        .state::<crate::desktop::Desktop>()
        .prefs
        .lock()
        .unwrap()
        .pet;
    let autostart =
        crate::get_autostart(app.clone()).unwrap_or_else(|reason| crate::AutostartState {
            enabled: false,
            supported: false,
            reason,
        });
    Ok(TrayState {
        generation: GENERATION.load(Ordering::SeqCst),
        active: ACTIVE.load(Ordering::SeqCst),
        pet,
        pomodoro_visible: crate::pomodoro::widget_visible(&app),
        preview: app.config().identifier.ends_with(".preview"),
        autostart,
    })
}

#[tauri::command]
pub fn tray_menu_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    if window.label() != "tray-menu" {
        return Err("无效托盘菜单窗口".into());
    }
    if GENERATION.load(Ordering::SeqCst) == generation {
        dismiss(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn tray_menu_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: u64,
    action: String,
    enabled: Option<bool>,
) -> Result<(), String> {
    if window.label() != "tray-menu"
        || GENERATION.load(Ordering::SeqCst) != generation
        || !ACTIVE.load(Ordering::SeqCst)
    {
        return Err("托盘菜单已关闭，请重新打开。".into());
    }
    match action.as_str() {
        "ai" => { dismiss(&app); crate::desktop::desktop_ai_open(app).await?; }
        "capture" => { dismiss(&app); crate::desktop::desktop_capture_begin(app).await?; }
        "pet" => {
            crate::desktop::desktop_preferences_save(
                app,
                crate::desktop::PreferencePatch {
                    pet: Some(enabled.ok_or("缺少桌宠开关状态")?),
                    ..Default::default()
                },
            )
            .await?;
        }
        "autostart" => {
            crate::set_autostart(app.clone(), enabled.ok_or("缺少自启开关状态")?)?;
        }
        "pomodoro_widget" => {
            if enabled.ok_or("缺少专注时钟开关状态")? {
                crate::pomodoro::pomodoro_show_controls(app.clone(), Some(false), None).await?;
            } else {
                crate::pomodoro::hide_widget(&app);
            }
            dismiss(&app);
        }
        "pomodoro" => {
            crate::desktop::desktop_main(
                app.clone(),
                None,
                None,
                None,
                None,
                Some("pomodoro".into()),
            )?;
            dismiss(&app);
        }
        "show" => {
            crate::desktop::desktop_main(
                app.clone(),
                None,
                None,
                None,
                None,
                Some("current".into()),
            )?;
            dismiss(&app);
        }
        "new_chat" | "plans" | "settings" => {
            crate::desktop::desktop_main(
                app.clone(),
                None,
                Some(action == "settings"),
                Some("general".into()),
                Some(action == "new_chat"),
                (action == "plans").then(|| "plans".into()),
            )?;
            dismiss(&app);
        }
        "quit" => {
            dismiss(&app);
            app.emit_to("main", "xiaoxi-close-learning", true)
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("未知托盘菜单操作".into()),
    }
    Ok(())
}
