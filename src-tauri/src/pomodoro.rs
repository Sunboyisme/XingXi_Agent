//! Shared clock snapshots and a freely movable desktop control strip.
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Listener, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

// User-selected proposal 02, "木质轻敲". Static storage keeps the WAV buffer
// valid for the entire lifetime of asynchronous native playback.
static COMPLETION_SOUND: &[u8] = include_bytes!("../assets/sounds/pomodoro-complete.wav");

#[derive(Clone, Copy, Serialize, Deserialize)]
struct Position {
    x: i32,
    y: i32,
}
#[derive(Clone, Copy)]
struct DragOrigin {
    cursor: Position,
    window: Position,
}
#[derive(Default)]
pub struct Widget {
    position: Mutex<Option<Position>>,
    standalone_position: Mutex<Option<Position>>,
    dragging: AtomicBool,
    drag_origin: Mutex<Option<DragOrigin>>,
    active: AtomicBool,
    suppressed: AtomicBool,
    manual_visible: AtomicBool,
    hit_mode: AtomicU8,
    latest_snapshot: Mutex<Option<(u64, f64)>>,
    notice_sequence: AtomicU64,
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
    .title("XiaoXi · 桌面专注时钟")
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
    WebviewWindowBuilder::new(app, "pomodoro-notice", WebviewUrl::App("index.html?view=pomodoro-notice".into()))
        .title("XiaoXi · 专注完成").inner_size(480.0, 228.0).decorations(false)
        .transparent(true).background_color(tauri::window::Color(0, 0, 0, 0)).always_on_top(true)
        .skip_taskbar(true).resizable(false).shadow(false).focused(false).visible(false)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}
pub fn place_widget(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Widget>();
    if state.dragging.load(Ordering::SeqCst) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return Ok(());
    };
    let desired = (*state.position.lock().unwrap()).or(*state.standalone_position.lock().unwrap());
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let monitor = if let Some(anchor) = desired {
        monitors.into_iter().min_by_key(|monitor| {
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
    } else {
        // Default placement belongs to the timer, independent of the pet.
        let (x, y) = crate::desktop_input::cursor();
        window
            .monitor_from_point(f64::from(x), f64::from(y))
            .map_err(|e| e.to_string())?
            .or(window.primary_monitor().map_err(|e| e.to_string())?)
    }
    .ok_or("无法读取显示器工作区")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let width = size.width as i32;
    let height = size.height as i32;
    let at = desired.unwrap_or(Position {
        x: area.position.x + (f64::from(area.size.width) * 0.912).round() as i32 - width / 2,
        y: area.position.y + (f64::from(area.size.height) * 0.518).round() as i32
            - (28.0 * scale).round() as i32,
    });
    if state.position.lock().unwrap().is_none() {
        *state.standalone_position.lock().unwrap() = Some(at);
    }
    let target = PhysicalPosition::new(
        at.x.clamp(
            area.position.x,
            (area.position.x + area.size.width as i32 - width).max(area.position.x),
        ),
        at.y.clamp(
            area.position.y,
            (area.position.y + area.size.height as i32 - height).max(area.position.y),
        ),
    );
    set_widget_bounds(&window, target.x, target.y, size.width, size.height)
}
fn set_widget_bounds(window: &tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let mut flags = SWP_NOACTIVATE | SWP_NOZORDER;
    if at.x == x && at.y == y { flags |= SWP_NOMOVE; }
    if size.width == width && size.height == height { flags |= SWP_NOSIZE; }
    if flags.contains(SWP_NOMOVE | SWP_NOSIZE) { return Ok(()); }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe { SetWindowPos(HWND(hwnd.0), None, x, y, width as i32, height as i32, flags)
        .map_err(|e| e.to_string()) }
}
#[tauri::command]
pub async fn pomodoro_widget_layout(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
    menu_open: bool,
) -> Result<(), String> {
    if window.label() != "pomodoro-timer" || !width.is_finite() || !height.is_finite() {
        return Err("计时条尺寸无效".into());
    }
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let old_size = window.outer_size().map_err(|e| e.to_string())?;
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let right = at.x + old_size.width as i32
        >= area.position.x + area.size.width as i32 - (24.0 * scale) as i32;
    let bottom = at.y + old_size.height as i32
        >= area.position.y + area.size.height as i32 - (24.0 * scale) as i32;
    let w = ((if menu_open { width.max(300.0) } else { width }).clamp(100.0, 600.0) * scale)
        .round()
        .min(area.size.width as f64) as u32;
    let h = ((if menu_open { height.max(410.0) } else { height }).clamp(48.0, 700.0) * scale)
        .round()
        .min(area.size.height as f64) as u32;
    let x = (if right {
        at.x + old_size.width as i32 - w as i32
    } else {
        at.x
    })
    .clamp(
        area.position.x,
        area.position.x + area.size.width.saturating_sub(w) as i32,
    );
    let y = (if bottom {
        at.y + old_size.height as i32 - h as i32
    } else {
        at.y
    })
    .clamp(
        area.position.y,
        area.position.y + area.size.height.saturating_sub(h) as i32,
    );
    set_widget_bounds(&window, x, y, w, h)?;
    let state = app.state::<Widget>();
    *state.position.lock().unwrap() = Some(Position { x, y });
    let _ = window.emit(
        "pomodoro-widget-anchor",
        serde_json::json!({"right":right,"bottom":bottom}),
    );
    Ok(())
}
#[tauri::command]
pub fn pomodoro_notice_close(app: tauri::AppHandle, sequence: u64) {
    if app.state::<Widget>().notice_sequence.load(Ordering::SeqCst) == sequence {
        if let Some(window) = app.get_webview_window("pomodoro-notice") {
            let _ = window.hide();
            let _ = window.emit("pomodoro-notice-hidden", ());
        }
    }
}
fn show_focus_notice(app: &tauri::AppHandle, sequence: u64) {
    let Some(window) = app.get_webview_window("pomodoro-notice") else {
        return;
    };
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let size = window
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(480, 228));
        let _ = window.set_position(PhysicalPosition::new(
            area.position.x + area.size.width.saturating_sub(size.width) as i32
                - (16.0 * scale) as i32,
            area.position.y + area.size.height.saturating_sub(size.height) as i32
                - (16.0 * scale) as i32,
        ));
    }
    app.state::<Widget>()
        .notice_sequence
        .store(sequence, Ordering::SeqCst);
    let _ = window.emit("pomodoro-notice-open", sequence);
    let _ = crate::desktop_window::show_without_focus(&window);
}

pub fn refresh_visibility(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return;
    };
    let state = app.state::<Widget>();
    let desktop = app.state::<crate::desktop::Desktop>();
    let enabled = desktop.prefs.lock().unwrap().pomodoro;
    let capturing = desktop.capture_starting.load(Ordering::SeqCst)
        || desktop.capture.lock().unwrap().is_some()
        || desktop
            .hidden
            .lock()
            .unwrap()
            .iter()
            .any(|label| label == "pomodoro-timer");
    let show = enabled
        && !capturing
        && !state.suppressed.load(Ordering::SeqCst)
        && (state.active.load(Ordering::SeqCst) || state.manual_visible.load(Ordering::SeqCst));
    if show {
        if !window.is_visible().unwrap_or(false) {
            let _ = place_widget(app);
            let _ = crate::desktop::show_without_focus(&window);
            let _ = app.emit("pomodoro-widget-visibility", widget_visible(app));
        }
    } else if window.is_visible().unwrap_or(false) {
        let _ = window.emit("pomodoro-widget-dismissed", ());
        let _ = window.hide();
        let _ = app.emit("pomodoro-widget-visibility", false);
    }
}
pub fn preferences_changed(app: &tauri::AppHandle, previous: bool, enabled: bool) {
    let state = app.state::<Widget>();
    if enabled && !previous {
        state.suppressed.store(false, Ordering::SeqCst);
        state.manual_visible.store(true, Ordering::SeqCst);
    } else if !enabled {
        state.manual_visible.store(false, Ordering::SeqCst);
        state.suppressed.store(true, Ordering::SeqCst);
    }
    refresh_visibility(app);
}
pub(crate) fn widget_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("pomodoro-timer")
        .is_some_and(|window| window.is_visible().unwrap_or(false))
}
pub fn hide_widget(app: &tauri::AppHandle) {
    app.state::<Widget>()
        .manual_visible
        .store(false, Ordering::SeqCst);
    app.state::<Widget>()
        .suppressed
        .store(true, Ordering::SeqCst);
    refresh_visibility(app);
}
pub fn update_hit_test(
    window: &tauri::WebviewWindow,
    regions: &[crate::desktop::HitRegion],
) -> Result<bool, String> {
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y) = crate::desktop_input::cursor();
    let x = f64::from(x - at.x) / scale;
    let y = f64::from(y - at.y) / scale;
    let inside = regions.iter().any(|r| {
        if x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height {
            return false;
        }
        let radius = r.border_radius.min(r.width / 2.0).min(r.height / 2.0);
        let dx = x - x.clamp(r.x + radius, r.x + r.width - radius);
        let dy = y - y.clamp(r.y + radius, r.y + r.height - radius);
        dx * dx + dy * dy <= radius * radius
    });
    let state = window.state::<Widget>();
    let capture = inside || state.dragging.load(Ordering::SeqCst);
    let mode = if capture { 2 } else { 1 };
    if state.hit_mode.load(Ordering::SeqCst) != mode {
        crate::desktop_window::ignore_cursor_events(window, !capture)?;
        state.hit_mode.store(mode, Ordering::SeqCst);
        let _ = window.emit("pomodoro-widget-pointer", inside);
    }
    Ok(inside)
}
pub fn pointer_update(app: &tauri::AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    let held = unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON.0)) } < 0;
    if update_drag(app, held) {
        return;
    }
    let Some(window) = app.get_webview_window("pomodoro-timer") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let regions = app
        .state::<crate::desktop::Desktop>()
        .hit_regions
        .lock()
        .unwrap()
        .get("pomodoro-timer")
        .cloned()
        .unwrap_or_default();
    let _ = update_hit_test(&window, &regions);
}
#[tauri::command]
pub async fn pomodoro_show_controls(
    app: tauri::AppHandle,
    focus: Option<bool>,
    automatic: Option<bool>,
) -> Result<bool, String> {
    let enabled = app
        .state::<crate::desktop::Desktop>()
        .prefs
        .lock()
        .unwrap()
        .pomodoro;
    if !enabled {
        if automatic.unwrap_or(false) {
            return Ok(false);
        }
        crate::desktop::desktop_preferences_save(
            app.clone(),
            crate::desktop::PreferencePatch {
                pomodoro: Some(true),
                ..Default::default()
            },
        )
        .await?;
    }
    let state = app.state::<Widget>();
    state.suppressed.store(false, Ordering::SeqCst);
    if !automatic.unwrap_or(false) {
        state.manual_visible.store(true, Ordering::SeqCst);
    }
    place_widget(&app)?;
    refresh_visibility(&app);
    let shown = widget_visible(&app);
    if !shown && !automatic.unwrap_or(false) {
        return Err("桌面专注时钟暂未显示，请结束截图后重试。".into());
    }
    if shown && focus.unwrap_or(false) {
        app.get_webview_window("pomodoro-timer")
            .ok_or("计时浮窗不可用")?
            .set_focus()
            .map_err(|e| e.to_string())?;
    }
    Ok(shown)
}
#[tauri::command]
pub fn pomodoro_widget_reset(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<Widget>().dragging.load(Ordering::SeqCst) {
        return Err("请先结束拖动，再恢复计时位置。".into());
    }
    persist(&app, None)?;
    *app.state::<Widget>().position.lock().unwrap() = None;
    app.state::<Widget>()
        .standalone_position
        .lock()
        .unwrap()
        .take();
    place_widget(&app)
}
#[tauri::command]
pub fn pomodoro_widget_drag(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    if window.label() != "pomodoro-timer" {
        return Err("计时浮窗不可用".into());
    }
    if unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(i32::from(
            windows::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON.0,
        ))
    } >= 0
    {
        return Ok(false);
    }
    let at = window.outer_position().map_err(|e| e.to_string())?;
    let (x, y) = crate::desktop_input::cursor();
    let state = app.state::<Widget>();
    *state.drag_origin.lock().unwrap() = Some(DragOrigin {
        cursor: Position { x, y },
        window: Position { x: at.x, y: at.y },
    });
    state.dragging.store(true, Ordering::SeqCst);
    Ok(true)
}
fn update_drag(app: &tauri::AppHandle, held: bool) -> bool {
    let state = app.state::<Widget>();
    if !state.dragging.load(Ordering::SeqCst) {
        return false;
    }
    if !held {
        finish_drag(app);
        return true;
    }
    let origin = *state.drag_origin.lock().unwrap();
    if let (Some(origin), Some(window)) = (origin, app.get_webview_window("pomodoro-timer")) {
        let (x, y) = crate::desktop_input::cursor();
        let target = PhysicalPosition::new(
            origin.window.x + x - origin.cursor.x,
            origin.window.y + y - origin.cursor.y,
        );
        if window.outer_position().ok() != Some(target) {
            if let Err(error) = window.set_position(target) {
                let _ = window.emit("pomodoro-widget-error", error.to_string());
                finish_drag(app);
            }
        }
    }
    true
}
fn finish_drag(app: &tauri::AppHandle) {
    let state = app.state::<Widget>();
    if !state.dragging.load(Ordering::SeqCst) {
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
    state.drag_origin.lock().unwrap().take();
    let _ = place_widget(app);
    if let Some(window) = app.get_webview_window("pomodoro-timer") {
        let regions = app
            .state::<crate::desktop::Desktop>()
            .hit_regions
            .lock()
            .unwrap()
            .get("pomodoro-timer")
            .cloned()
            .unwrap_or_default();
        let inside = update_hit_test(&window, &regions).unwrap_or(false);
        let _ = window.emit(
            "pomodoro-widget-drag-ended",
            serde_json::json!({ "inside": inside }),
        );
    }
}
fn play_completion_sound(volume: u8) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT},
    };
    if volume > 100 { return Err("提示音音量应在0到100之间。".into()); }
    if volume == 0 { return Ok(()); }
    // Keep requested gains alive for asynchronous playback. Only this PCM sound
    // is scaled; device/session volume changes would affect other audio.
    static SCALED: std::sync::LazyLock<Mutex<std::collections::HashMap<u8, Box<[u8]>>>> =
        std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let mut sounds = SCALED.lock().unwrap();
    let sound = sounds.entry(volume).or_insert_with(|| {
        let mut bytes = COMPLETION_SOUND.to_vec();
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let start = offset + 8;
            let end = (start + length).min(bytes.len());
            if &bytes[offset..offset + 4] == b"data" {
                for sample in bytes[start..end].chunks_exact_mut(2) {
                    let value = i32::from(i16::from_le_bytes([sample[0], sample[1]]));
                    sample.copy_from_slice(&((value * i32::from(volume) / 100) as i16).to_le_bytes());
                }
                break;
            }
            offset = start + length + (length % 2);
        }
        bytes.into_boxed_slice()
    });
    // With SND_MEMORY, PlaySound interprets this pointer as WAV bytes, not text.
    let started = unsafe {
        PlaySoundW(
            PCWSTR(sound.as_ptr().cast()),
            None,
            SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
        )
    };
    if started.as_bool() {
        Ok(())
    } else {
        Err("无法播放完成提示音，请检查音频输出设备。".into())
    }
}
#[tauri::command]
pub fn pomodoro_preview_sound(volume: Option<u8>) -> Result<(), String> {
    play_completion_sound(volume.unwrap_or(100))
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
    state.active.store(phase != "idle", Ordering::SeqCst);
    drop(latest);
    if phase != "waiting_break" {
        if let Some(window) = app.get_webview_window("pomodoro-notice") {
            let _ = window.hide(); let _ = window.emit("pomodoro-notice-hidden", ());
        }
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
                                let accepted = accept_snapshot(&app, &value);
                                if accepted {
                                    let _ = app.emit("pomodoro-snapshot", &value);
                                }
                                if accepted && seen.is_some_and(|previous| sequence > previous) {
                                    if value["notification_kind"] == "focus_complete" && value["phase"] == "waiting_break" {
                                        show_focus_notice(&app, sequence);
                                    }
                                    if value["notification_kind"] != "focus_complete" && !widget_visible(&app) {
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
                                        let volume = value["preferences"]["sound_volume"].as_u64().unwrap_or(100).min(100) as u8;
                                        let _ = play_completion_sound(volume);
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
