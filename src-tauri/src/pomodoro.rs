//! Shared clock snapshots and a freely movable desktop control strip.
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Position {
    x: i32,
    y: i32,
}
#[derive(Default)]
pub struct Widget {
    position: Mutex<Option<Position>>,
    dragging: AtomicBool,
    active: AtomicBool,
    suppressed: AtomicBool,
    preview_until: Mutex<Option<Instant>>,
}
fn placement_path(app: &tauri::AppHandle) -> PathBuf {
    app.state::<crate::Backend>()
        .data_dir
        .get()
        .unwrap()
        .join("pomodoro-widget.json")
}
fn persist(app: &tauri::AppHandle, value: Option<Position>) -> Result<(), String> {
    static SAVE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SAVE_LOCK.lock().unwrap();
    let path = placement_path(app);
    let temporary = path.with_extension("tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}
pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Ok(bytes) = std::fs::read(placement_path(app)) {
        if let Ok(value) = serde_json::from_slice::<Option<Position>>(&bytes) {
            *app.state::<Widget>().position.lock().unwrap() = value;
        }
    }
    WebviewWindowBuilder::new(
        app,
        "pomodoro-timer",
        WebviewUrl::App("index.html?view=pomodoro-timer".into()),
    )
    .title("XiaoXi · 番茄钟")
    .inner_size(276.0, 168.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn pet_visible(app: &tauri::AppHandle) -> bool {
    let desktop = app.state::<crate::desktop::Desktop>();
    !desktop.pet_exiting.load(Ordering::SeqCst)
        && desktop.capture.lock().unwrap().is_none()
        && app
            .get_webview_window("pet")
            .is_some_and(|window| window.is_visible().unwrap_or(false))
}
pub fn place_widget(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Widget>();
    if state.dragging.load(Ordering::SeqCst) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return Ok(());
    };
    let mut desired = *state.position.lock().unwrap();
    let mut anchor = desired;
    let mut below = None;
    if desired.is_none() {
        let pet = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
        let at = pet.outer_position().map_err(|e| e.to_string())?;
        let scale = pet.scale_factor().map_err(|e| e.to_string())?;
        let prefs = app
            .state::<crate::desktop::Desktop>()
            .prefs
            .lock()
            .unwrap()
            .clone();
        let diameter = 82.0 * f64::from(prefs.pet_size) / 100.0;
        let size = pet.inner_size().map_err(|e| e.to_string())?;
        let left = prefs
            .pet_offset_x
            .unwrap_or(size.width as f64 / scale - diameter - 8.0);
        let top = prefs
            .pet_offset_y
            .unwrap_or(size.height as f64 / scale - diameter - 6.0);
        anchor = Some(Position {
            x: at.x + ((left + diameter / 2.0) * scale).round() as i32,
            y: at.y + ((top + diameter / 2.0) * scale).round() as i32,
        });
        below = Some(at.y + ((top + diameter + 8.0) * scale).round() as i32);
        desired = Some(Position {
            x: at.x + ((left + diameter / 2.0 - 138.0) * scale).round() as i32,
            y: at.y + ((top - 58.0) * scale).round() as i32,
        });
    }
    let at = desired.unwrap();
    let anchor = anchor.unwrap_or(at);
    let monitor = window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .min_by_key(|monitor| {
            let area = monitor.work_area();
            let dx = i64::from(anchor.x)
                - i64::from(anchor.x).clamp(
                    i64::from(area.position.x),
                    i64::from(area.position.x) + i64::from(area.size.width),
                );
            let dy = i64::from(anchor.y)
                - i64::from(anchor.y).clamp(
                    i64::from(area.position.y),
                    i64::from(area.position.y) + i64::from(area.size.height),
                );
            dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
        })
        .ok_or("无法读取显示器工作区")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (276.0 * scale).round() as i32;
    let height = (168.0 * scale).round() as i32;
    let target = PhysicalPosition::new(
        at.x.clamp(
            area.position.x,
            (area.position.x + area.size.width as i32 - width).max(area.position.x),
        ),
        (if at.y < area.position.y {
            below.unwrap_or(at.y)
        } else {
            at.y
        })
        .clamp(
            area.position.y,
            (area.position.y + area.size.height as i32 - height).max(area.position.y),
        ),
    );
    if window.outer_position().map_err(|e| e.to_string())? != target {
        window.set_position(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn refresh_visibility(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return;
    };
    let state = app.state::<Widget>();
    let preview = state
        .preview_until
        .lock()
        .unwrap()
        .is_some_and(|until| Instant::now() < until || window.is_focused().unwrap_or(false));
    let show = pet_visible(app)
        && !state.suppressed.load(Ordering::SeqCst)
        && (state.active.load(Ordering::SeqCst) || preview);
    if show {
        let _ = place_widget(app);
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
    } else if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    }
}
pub fn hide_widget(app: &tauri::AppHandle) {
    app.state::<Widget>()
        .suppressed
        .store(true, Ordering::SeqCst);
    refresh_visibility(app);
}
#[tauri::command]
pub fn pomodoro_show_controls(app: tauri::AppHandle, focus: Option<bool>) {
    let state = app.state::<Widget>();
    state.suppressed.store(false, Ordering::SeqCst);
    *state.preview_until.lock().unwrap() = if state.active.load(Ordering::SeqCst) {
        None
    } else {
        Some(Instant::now() + Duration::from_secs(5))
    };
    refresh_visibility(&app);
    if focus.unwrap_or(false) {
        if let Some(window) = app.get_webview_window("pomodoro-timer") {
            let _ = window.set_focus();
        }
    }
}
#[tauri::command]
pub fn pomodoro_widget_reset(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Widget>().dragging.load(Ordering::SeqCst) {
        return Err("请先结束拖动，再恢复计时位置。".into());
    }
    persist(&app, None)?;
    *app.state::<Widget>().position.lock().unwrap() = None;
    place_widget(&app)
}
#[tauri::command]
pub fn pomodoro_widget_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "pomodoro-timer" {
        return Err("计时浮窗不可用".into());
    }
    app.state::<Widget>().dragging.store(true, Ordering::SeqCst);
    if let Err(error) = window.start_dragging() {
        app.state::<Widget>()
            .dragging
            .store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    Ok(())
}
fn finish_drag(app: &tauri::AppHandle) {
    let state = app.state::<Widget>();
    if !state.dragging.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(windows)]
    if unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(i32::from(
            windows::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON.0,
        ))
    } < 0
    {
        return;
    }
    if let Some(window) = app.get_webview_window("pomodoro-timer") {
        if let Ok(at) = window.outer_position() {
            let position = Position { x: at.x, y: at.y };
            *state.position.lock().unwrap() = Some(position);
            if let Err(error) = persist(app, Some(position)) {
                let _ = window.emit("pomodoro-widget-error", error);
            }
        }
    }
    state.dragging.store(false, Ordering::SeqCst);
    let _ = place_widget(app);
}
pub fn start(app: tauri::AppHandle, backend_url: String, data_dir: PathBuf) {
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        else {
            return;
        };
        let mut seen: Option<u64> = None;
        loop {
            let start = Instant::now();
            finish_drag(&app);
            if let Ok(token) = std::fs::read_to_string(data_dir.join("auth-token")) {
                if let Ok(response) = client
                    .get(format!("{backend_url}/pomodoro"))
                    .bearer_auth(token.trim())
                    .send()
                {
                    if response.status().is_success() {
                        if let Ok(value) = response.json::<serde_json::Value>() {
                            if let Some(sequence) = value["notification_seq"].as_u64() {
                                let active = value["phase"] != "idle";
                                app.state::<Widget>().active.store(active, Ordering::SeqCst);
                                let _ = app.emit("pomodoro-snapshot", &value);
                                if seen.is_some_and(|previous| sequence > previous) {
                                    app.state::<Widget>()
                                        .suppressed
                                        .store(false, Ordering::SeqCst);
                                    if !pet_visible(&app) {
                                        let focus = value["notification_kind"] == "focus_complete";
                                        let _ = app
                                            .notification()
                                            .builder()
                                            .title(if focus {
                                                "专注完成"
                                            } else {
                                                "休息结束"
                                            })
                                            .body(if focus {
                                                "本轮专注已完成。"
                                            } else {
                                                "休息已结束。"
                                            })
                                            .show();
                                    }
                                    if value["preferences"]["sound_enabled"]
                                        .as_bool()
                                        .unwrap_or(true)
                                    {
                                        #[cfg(windows)]
                                        unsafe {
                                            let _ = windows::Win32::System::Diagnostics::Debug::MessageBeep(windows::Win32::UI::WindowsAndMessaging::MB_OK);
                                        }
                                    }
                                }
                                seen = Some(sequence);
                            }
                        }
                    }
                }
            }
            refresh_visibility(&app);
            std::thread::sleep(Duration::from_secs(1).saturating_sub(start.elapsed()));
        }
    });
}
