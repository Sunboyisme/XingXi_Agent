//! Shared clock snapshots and a freely movable desktop control strip.
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Listener, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
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
    previewing: AtomicBool,
    mouse_buttons: AtomicU8,
    latest_snapshot: Mutex<Option<(u64, f64)>>,
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
    .background_color(tauri::window::Color(0, 0, 0, 0))
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
    let show = pet_visible(app)
        && !state.suppressed.load(Ordering::SeqCst)
        && (state.active.load(Ordering::SeqCst) || state.previewing.load(Ordering::SeqCst));
    if show {
        let _ = place_widget(app);
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
    } else if window.is_visible().unwrap_or(false) {
        let _ = window.emit("pomodoro-widget-dismissed", ());
        let _ = window.hide();
    }
}
pub fn hide_widget(app: &tauri::AppHandle) {
    app.state::<Widget>()
        .previewing
        .store(false, Ordering::SeqCst);
    app.state::<Widget>()
        .suppressed
        .store(true, Ordering::SeqCst);
    refresh_visibility(app);
}
pub fn focus_lost(app: &tauri::AppHandle) {
    // Running / paused sessions stay visible; only the idle preview is dismissed.
    app.state::<Widget>()
        .previewing
        .store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("pomodoro-timer") {
        let _ = window.emit("pomodoro-widget-dismissed", ());
    }
    refresh_visibility(app);
}
pub fn pointer_update(app: &tauri::AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    let state = app.state::<Widget>();
    let mut buttons = 0u8;
    for (index, key) in [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].iter().enumerate() {
        if unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0 {
            buttons |= 1 << index;
        }
    }
    let previous = state.mouse_buttons.swap(buttons, Ordering::SeqCst);
    finish_drag(app);
    if buttons & !previous == 0
        || !state.previewing.load(Ordering::SeqCst)
        || state.active.load(Ordering::SeqCst)
        || state.dragging.load(Ordering::SeqCst)
    {
        return;
    }
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(at), Ok(scale)) = (window.outer_position(), window.scale_factor()) else {
        return;
    };
    let (x, y) = crate::desktop_input::cursor();
    let x = f64::from(x - at.x) / scale;
    let y = f64::from(y - at.y) / scale;
    let inside = app
        .state::<crate::desktop::Desktop>()
        .hit_regions
        .lock()
        .unwrap()
        .get("pomodoro-timer")
        .is_some_and(|regions| {
            regions.iter().any(|r| {
                x >= r.x - 1.0
                    && x <= r.x + r.width + 1.0
                    && y >= r.y - 1.0
                    && y <= r.y + r.height + 1.0
            })
        });
    if !inside {
        focus_lost(app);
    }
}
#[tauri::command]
pub fn pomodoro_show_controls(app: tauri::AppHandle, focus: Option<bool>) {
    let state = app.state::<Widget>();
    state.suppressed.store(false, Ordering::SeqCst);
    state
        .previewing
        .store(!state.active.load(Ordering::SeqCst), Ordering::SeqCst);
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
fn accept_snapshot(app: &tauri::AppHandle, value: &serde_json::Value) -> bool {
    let (Some(revision), Some(server_now), Some(phase)) = (
        value["revision"].as_u64(),
        value["server_now"].as_f64(),
        value["phase"].as_str(),
    ) else {
        return false;
    };
    if !server_now.is_finite()
        || !["idle", "focus", "break", "waiting_break", "waiting_focus"].contains(&phase)
    {
        return false;
    }
    let state = app.state::<Widget>();
    let mut latest = state.latest_snapshot.lock().unwrap();
    if latest.is_some_and(|(old_revision, old_time)| {
        revision < old_revision || (revision == old_revision && server_now <= old_time)
    }) {
        return false;
    }
    *latest = Some((revision, server_now));
    let active = phase != "idle";
    let was_active = state.active.swap(active, Ordering::SeqCst);
    if active || was_active {
        state.previewing.store(false, Ordering::SeqCst);
    }
    true
}
pub fn start(app: tauri::AppHandle, backend_url: String, data_dir: PathBuf) {
    let bridge = app.clone();
    app.listen("pomodoro-snapshot", move |event| {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if accept_snapshot(&bridge, &value) {
                refresh_visibility(&bridge);
            }
        }
    });
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
            if let Ok(token) = std::fs::read_to_string(data_dir.join("auth-token")) {
                if let Ok(response) = client
                    .get(format!("{backend_url}/pomodoro"))
                    .bearer_auth(token.trim())
                    .send()
                {
                    if response.status().is_success() {
                        if let Ok(value) = response.json::<serde_json::Value>() {
                            if let Some(sequence) = value["notification_seq"].as_u64() {
                                if accept_snapshot(&app, &value) {
                                    let _ = app.emit("pomodoro-snapshot", &value);
                                }
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
