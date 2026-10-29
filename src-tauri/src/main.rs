#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend_port;
mod window_layout;
mod drop_files;
mod desktop;
mod desktop_input;
mod voice;

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(not(debug_assertions))]
use std::process::Stdio;
use std::{
    path::PathBuf,
    process::{Child, Command},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::ManagerExt as AutostartExt;

struct Backend {
    child: Mutex<Option<Child>>,
    data_dir: OnceLock<PathBuf>,
    url: OnceLock<String>,
}
#[derive(Serialize)]
struct Connection {
    url: String,
    token: String,
}

#[tauri::command]
fn backend_config(state: tauri::State<'_, Backend>) -> Result<Connection, String> {
    let data_dir = state.data_dir.get().ok_or("本机服务正在启动，请稍候。")?;
    let token = std::fs::read_to_string(data_dir.join("auth-token"))
        .map_err(|_| "本机服务正在启动，请稍候。")?;
    Ok(Connection {
        url: state.url.get().ok_or("本机服务正在启动，请稍候。")?.clone(),
        token: token.trim().into(),
    })
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    let _ = app.emit("xiaoxi-close-learning", true);
}

#[tauri::command]
fn finish_learning_close(app: tauri::AppHandle, quit: bool) -> Result<(), String> {
    if quit {
        app.exit(0);
        Ok(())
    } else {
        app.get_webview_window("main").ok_or("主窗口不存在")?.hide().map_err(|error| error.to_string())
    }
}

#[tauri::command]
async fn pick_project_workspaces(initial_path: Option<String>) -> Result<Option<Vec<String>>, String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("选择项目本地文件夹（按住 Ctrl 可多选）");
    if let Some(path) = initial_path.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_dir() {
            dialog = dialog.set_directory(path);
        }
    }
    let Some(folders) = dialog.pick_folders().await else {
        return Ok(None);
    };
    let mut paths = Vec::with_capacity(folders.len());
    for folder in folders {
        if !folder.path().is_dir() {
            return Err("所选文件夹已失效，请重新选择".into());
        }
        paths.push(folder.path().to_string_lossy().into_owned());
    }
    Ok(Some(paths))
}

#[tauri::command]
async fn save_data_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("导出 XiaoXi 数据")
        .set_file_name("XiaoXi-data.zip")
        .add_filter("ZIP 数据文件", &["zip"]);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let Some(file) = dialog.save_file().await else {
        return Ok(None);
    };
    let target = file.path().to_path_buf();
    let root = state.data_dir.get().ok_or("服务尚未就绪")?.clone();
    let url = state.url.get().ok_or("服务尚未就绪")?.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let token = std::fs::read_to_string(root.join("auth-token"))
            .map_err(|_| "无法验证数据访问权限")?;
        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "无法连接数据服务")?
            .post(format!("{url}/settings/data/export"))
            .bearer_auth(token.trim())
            .send()
            .map_err(|_| "导出数据失败")?;
        if !response.status().is_success() {
            return Err("数据导出失败，请稍后重试".into());
        }
        let value: serde_json::Value = response.json().map_err(|_| "导出结果无效")?;
        let name = value["name"].as_str().ok_or("导出文件名无效")?;
        if !name.ends_with(".zip") || name.contains(['/', '\\', ':']) || name.contains("..") {
            return Err("导出文件名无效".into());
        }
        std::fs::read(root.join("exports").join(name)).map_err(|_| "读取导出文件失败".into())
    })
    .await
    .map_err(|_| "数据导出任务失败")??;
    write_atomically(target.clone(), bytes).await?;
    Ok(Some(target.to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_office_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    file_id: String,
    name: String,
    upload: bool,
) -> Result<bool, String> {
    let bytes = read_office_bytes(&state, &file_id, upload, false).await?;
    let safe_name: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(180)
        .collect();
    let mut dialog = rfd::AsyncFileDialog::new().set_file_name(if safe_name.is_empty() {
        "文件"
    } else {
        &safe_name
    });
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let selected = dialog.save_file().await;
    let Some(file) = selected else {
        return Ok(false);
    };
    let path = file.path().to_path_buf();
    write_atomically(path, bytes).await?;
    Ok(true)
}

async fn read_office_bytes(
    state: &tauri::State<'_, Backend>,
    file_id: &str,
    upload: bool,
    knowledge: bool,
) -> Result<Vec<u8>, String> {
    if file_id.len() != 36 || !file_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("文件编号无效".into());
    }
    let root = state.data_dir.get().ok_or("服务尚未就绪")?.clone();
    let url = state.url.get().ok_or("服务尚未就绪")?.clone();
    let file_id = file_id.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let token =
            std::fs::read_to_string(root.join("auth-token")).map_err(|_| "无法验证文件访问权限")?;
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "无法连接文件服务")?;
        let response = client
            .get(if knowledge {
                format!("{url}/knowledge/documents/{file_id}/download")
            } else {
                format!("{}/{}/{}/content", url, if upload { "files" } else { "artifacts" }, file_id)
            })
            .bearer_auth(token.trim())
            .send()
            .map_err(|_| "读取文件失败")?;
        if !response.status().is_success() {
            return Err("文件不存在或当前无法读取".into());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        response
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "读取文件失败")?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("文件超过另存为大小限制".into());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "文件读取任务失败")?
}

async fn write_atomically(path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        let parent = path.parent().ok_or("保存位置无效")?;
        std::fs::create_dir_all(parent).map_err(|_| "无法创建保存目录")?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法在所选位置创建文件")?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "写入失败，原目标文件未替换")?;
        temporary
            .persist(&path)
            .map_err(|_| "文件被占用或保存失败，原目标文件未替换")?;
        Ok(())
    })
    .await
    .map_err(|_| "保存任务失败")?
}

fn download_target(folder: &std::path::Path, name: &str) -> PathBuf {
    let name = if name.trim().is_empty() {
        "文件"
    } else {
        name
    };
    let path = std::path::Path::new(name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("文件");
    let suffix = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    for index in 2..1000 {
        let candidate = folder.join(format!("{stem} ({index}){suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(name)
}

#[derive(Serialize)]
struct AutostartState { enabled: bool, supported: bool, reason: String }

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<AutostartState, String> {
    if cfg!(debug_assertions) || app.config().identifier.ends_with(".preview") {
        return Ok(AutostartState { enabled: false, supported: false, reason: "开机自启仅安装版可设置，测试版不注册系统启动项。".into() });
    }
    let enabled = app.autolaunch().is_enabled().map_err(|_| "无法读取 Windows 自启状态")?;
    Ok(AutostartState { enabled, supported: true, reason: String::new() })
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<AutostartState, String> {
    if !get_autostart(app.clone())?.supported { return Err("测试版不注册系统启动项".into()); }
    if enabled { app.autolaunch().enable() } else { app.autolaunch().disable() }
        .map_err(|_| "更新 Windows 开机自启失败，请检查系统权限")?;
    get_autostart(app)
}

#[tauri::command]
async fn download_knowledge_file(app: tauri::AppHandle, state: tauri::State<'_, Backend>, file_id: String, name: String) -> Result<String, String> {
    let bytes = read_office_bytes(&state, &file_id, false, true).await?;
    let safe_name: String = name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(180).collect();
    let folder = app.path().download_dir().map_err(|_| "找不到下载文件夹")?;
    std::fs::create_dir_all(&folder).map_err(|_| "无法创建下载文件夹")?;
    let target = download_target(&folder, &safe_name);
    write_atomically(target.clone(), bytes).await?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
async fn download_office_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, Backend>,
    file_id: String,
    name: String,
    upload: bool,
) -> Result<String, String> {
    let bytes = read_office_bytes(&state, &file_id, upload, false).await?;
    let safe_name: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(180)
        .collect();
    let folder = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
        .map_err(|_| "找不到 Windows 下载文件夹")?;
    std::fs::create_dir_all(&folder).map_err(|_| "无法创建下载文件夹")?;
    let target = download_target(&folder, &safe_name);
    write_atomically(target.clone(), bytes).await?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn open_download_location(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err("文件不存在或已被移动".into());
    }
    let folder = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
        .map_err(|_| "找不到 Windows 下载文件夹")?;
    if !file.starts_with(&folder) {
        return Err("只能打开下载文件夹中的文件".into());
    }
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", file.display()))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开下载文件夹".to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("请在系统文件管理器中打开下载文件夹".into())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "网页地址无效")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.chars().any(|c| c.is_control() || c == '"')
    {
        return Err("只支持 HTTP 或 HTTPS 网页地址".into());
    }
    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(parsed.as_str())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开系统浏览器".to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("请复制链接到浏览器打开".into())
}

#[tauri::command]
fn open_data_directory(
    state: tauri::State<'_, Backend>,
    exports: Option<bool>,
) -> Result<(), String> {
    let root = state.data_dir.get().ok_or("数据目录尚未就绪")?;
    let folder = if exports.unwrap_or(false) {
        root.join("exports")
    } else {
        root.clone()
    };
    std::fs::create_dir_all(&folder).map_err(|_| "无法创建导出目录".to_string())?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(&folder)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法打开数据目录".to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("请使用显示的路径打开数据目录".into())
}

#[tauri::command]
fn ensure_window_visible(window: tauri::WebviewWindow) -> Result<(), String> {
    window_layout::ensure_visible(&window).map_err(|error| error.to_string())
}

#[tauri::command]
fn restore_window_layout(window: tauri::WebviewWindow) -> Result<(), String> {
    window_layout::fit_main_window(&window).map_err(|error| error.to_string())
}

fn place_reminder_window(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (420.0 * scale).round() as i32;
    let height = (360.0 * scale).round() as i32;
    let margin = (18.0 * scale).round() as i32;
    let x = area.position.x + area.size.width as i32 - width - margin;
    let y = area.position.y + area.size.height as i32 - height - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn open_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window_layout::ensure_visible(&window);
        let _ = window.set_focus();
    }
}

#[allow(dead_code)]
fn migrate_legacy_data(legacy: &std::path::Path, current: &std::path::Path) -> bool {
    if current.join("bai.sqlite").exists() || !legacy.join("bai.sqlite").exists() {
        return true;
    }
    if std::fs::create_dir_all(current).is_err() {
        return false;
    }
    let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    // The running WebView keeps EBWebView open; move the application's own
    // files and leave that cache behind rather than failing the whole move.
    for name in [
        "bai.sqlite",
        "bai.sqlite-wal",
        "bai.sqlite-shm",
        "checkpoints.sqlite",
        "checkpoints.sqlite-wal",
        "checkpoints.sqlite-shm",
        "auth-token",
    ] {
        let source = legacy.join(name);
        if !source.exists() {
            continue;
        }
        let target = current.join(name);
        if std::fs::rename(&source, &target).is_err() {
            for (from, to) in moved.iter().rev() {
                let _ = std::fs::rename(to, from);
            }
            return false;
        }
        moved.push((source, target));
    }
    if let Ok(entries) = std::fs::read_dir(legacy) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == "EBWebView" || current.join(&name).exists() {
                continue;
            }
            let source = entry.path();
            let target = current.join(&name);
            if std::fs::rename(&source, &target).is_err() {
                for (from, to) in moved.iter().rev() {
                    let _ = std::fs::rename(to, from);
                }
                return false;
            }
            moved.push((source, target));
        }
    }
    true
}

fn main() {
    let preferred_port: u16 = std::env::var("BAI_BACKEND_PORT")
        .unwrap_or_else(|_| "8766".into())
        .parse()
        .expect("BAI_BACKEND_PORT 必须是有效端口");
    assert!(preferred_port >= 1024, "BAI_BACKEND_PORT 必须大于等于 1024");
    let backend = Backend {
        child: Mutex::new(None),
        data_dir: OnceLock::new(),
        url: OnceLock::new(),
    };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--autostart") {
                open_main(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(desktop::Desktop::default())
        .manage(voice::Voice::default())
        .manage(backend)
        .manage(drop_files::DroppedPaths::default())
        .invoke_handler(tauri::generate_handler![
            backend_config,
            get_autostart,
            set_autostart,
            download_knowledge_file,
            drop_files::read_dropped_files,
            quit_app,
            finish_learning_close,
            pick_project_workspaces,
            save_data_export,
            save_office_file,
            download_office_file,
            open_download_location,
            open_data_directory,
            open_external_url,
            ensure_window_visible,
            restore_window_layout,
            desktop::desktop_preferences,
            desktop::desktop_preferences_save,
            desktop::desktop_open,
            desktop::desktop_pet_drag,
            desktop::desktop_pet_reset,
            desktop::desktop_hit_regions,
            desktop::desktop_quick_state,
            desktop::desktop_ask_session,
            desktop::desktop_commands_take,
            desktop::desktop_dismiss,
            desktop::desktop_toggle,
            desktop::desktop_main,
            desktop::desktop_resume,
            desktop::desktop_chat,
            desktop::desktop_pick_files,
            desktop::capture_get,
            desktop::capture_present,
            desktop::capture_select,
            desktop::capture_pixels,
            desktop::capture_cancel,
            desktop::capture_export,
            desktop::pinned_image,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_audio_get
        ])
        .setup(move |app| {
            if !cfg!(debug_assertions) && !app.config().identifier.ends_with(".preview") {
                app.handle().plugin(tauri_plugin_autostart::Builder::new().app_name("XiaoXi").args(["--autostart"]).build())?;
                // Refresh an existing registration so upgrades also start in the tray.
                if app.autolaunch().is_enabled().unwrap_or(false) {
                    let _ = app.autolaunch().enable();
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                window_layout::fit_main_window(&window)?;
            }
            let data_dir = if let Some(folder) = std::env::var_os("BAI_DATA_DIR") {
                PathBuf::from(folder)
            } else {
                #[cfg(debug_assertions)]
                let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join(".local-data")
                    .join("dev");
                #[cfg(not(debug_assertions))]
                let folder = {
                    let current = app.path().local_data_dir()?.join("XiaoXi_Agent");
                    let legacy = app.path().app_local_data_dir()?;
                    if legacy != current && migrate_legacy_data(&legacy, &current) {
                        current
                    } else {
                        legacy
                    }
                };
                folder
            };
            std::fs::create_dir_all(&data_dir)?;
            let _ = app.state::<Backend>().data_dir.set(data_dir.clone());
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(1))
                .no_proxy()
                .build()?;
            let mut selected_port = backend_port::select_backend_port(preferred_port, |port| {
                let url = format!("http://127.0.0.1:{port}/api/v1");
                let online = client
                    .get(format!("{url}/health"))
                    .send()
                    .ok()
                    .and_then(|r| r.json::<serde_json::Value>().ok())
                    .is_some_and(|v| v["service"] == "bai-agent");
                if !online {
                    return false;
                }
                let token =
                    std::fs::read_to_string(data_dir.join("auth-token")).unwrap_or_default();
                !token.trim().is_empty()
                    && client
                        .get(format!("{url}/settings"))
                        .bearer_auth(token.trim())
                        .send()
                        .is_ok_and(|r| r.status().is_success())
            })?;
            let port = selected_port.port;
            let backend_url = format!("http://127.0.0.1:{port}/api/v1");
            let _ = app.state::<Backend>().url.set(backend_url.clone());
            if selected_port.needs_spawn() {
                #[cfg(debug_assertions)]
                let mut command = {
                    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .unwrap()
                        .to_path_buf();
                    let mut value = Command::new(root.join("backend/.venv/Scripts/python.exe"));
                    value
                        .args(["-m", "uvicorn", "app.main:app"])
                        .current_dir(root.join("backend"));
                    value
                };
                #[cfg(not(debug_assertions))]
                let mut command = {
                    let folder = app.path().resource_dir()?.join("backend");
                    let mut value = Command::new(folder.join("bai-backend.exe"));
                    value.current_dir(folder);
                    let log = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(data_dir.join("backend.log"))?;
                    value
                        .stdout(Stdio::from(log.try_clone()?))
                        .stderr(Stdio::from(log));
                    value
                };
                command
                    .args([
                        "--host",
                        "127.0.0.1",
                        "--port",
                        &port.to_string(),
                        "--no-access-log",
                    ])
                    .env("BAI_DATA_DIR", &data_dir);
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                selected_port.release();
                let child = command.spawn()?;
                *app.state::<Backend>().child.lock().unwrap() = Some(child);
            }
            let is_preview = app.config().identifier.ends_with(".preview");
            desktop::setup(app.handle()).map_err(std::io::Error::other)?;
            let tray_name = if is_preview {
                "XiaoXi（测试版）"
            } else {
                "XiaoXi"
            };
            let show = MenuItem::with_id(
                app,
                "show",
                format!("打开{tray_name}"),
                true,
                None::<&str>,
            )?;
            let new_chat = MenuItem::with_id(app, "new_chat", "新建对话", true, None::<&str>)?;
            let plans = MenuItem::with_id(app, "plans", "打开今日安排", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "连接与设置", true, None::<&str>)?;
            let exit = MenuItem::with_id(
                app,
                "quit",
                format!("退出{tray_name}"),
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &new_chat, &plans, &settings, &exit])?;
            let icon = app.default_window_icon().cloned().ok_or("应用图标缺失")?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip(tray_name)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => open_main(app),
                    "new_chat" | "plans" | "settings" => {
                        open_main(app);
                        let _ = app.emit("bai-tray-action", event.id.as_ref());
                    }
                    "quit" => { let _ = app.emit("xiaoxi-close-learning", true); },
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        open_main(tray.app_handle());
                    }
                })
                .build(app)?;
            let autostart_in_tray = !cfg!(debug_assertions) && !is_preview
                && std::env::args().any(|arg| arg == "--autostart");
            if !autostart_in_tray {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(3))
                    .build()
                    .unwrap();
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    let Ok(token) = std::fs::read_to_string(data_dir.join("auth-token")) else {
                        continue;
                    };
                    if let Ok(response) = client.get(format!("{backend_url}/runs")).bearer_auth(token.trim()).send() {
                        if let Ok(values) = response.json::<Vec<serde_json::Value>>() {
                            let mut batch = Vec::new();
                            for run in values.iter().rev() {
                                let Some(id) = run["id"].as_str() else { continue; };
                                let next = run["result"]["next_run_id"].is_string();
                                batch.push(serde_json::json!({
                                    "conversationId":run["conversation_id"], "source":"poll", "runId":id,
                                    "runStatus":run["status"], "taskId":run["task_id"],
                                    "taskStatus":run["task_status"], "hasNextRun":next, "updatedAt":run["updated_at"]
                                }));
                            }
                            let _ = handle.emit_to("pet", "desktop-task-snapshot", batch);
                        }
                    }
                    let Ok(response) = client
                        .get(format!("{backend_url}/notifications?pending_only=true"))
                        .bearer_auth(token.trim())
                        .send()
                    else {
                        continue;
                    };
                    let Ok(notes) = response.json::<Vec<serde_json::Value>>() else {
                        continue;
                    };
                    if notes.is_empty() {
                        continue;
                    }
                    for note in &notes {
                        let _ = handle
                            .notification()
                            .builder()
                            .title(note["title"].as_str().unwrap_or("XiaoXi提醒你"))
                            .body(note["body"].as_str().unwrap_or(""))
                            .show();
                    }
                    let window_ready = if let Some(window) = handle.get_webview_window("reminder") {
                        let shown = window.show().is_ok();
                        place_reminder_window(&window);
                        let _ = window.set_focus();
                        shown
                    } else {
                        match WebviewWindowBuilder::new(
                            &handle,
                            "reminder",
                            WebviewUrl::App("index.html?view=reminder".into()),
                        )
                        .title("XiaoXi提醒")
                        .inner_size(420.0, 360.0)
                        .resizable(false)
                        .decorations(false)
                        .transparent(true)
                        .shadow(false)
                        .skip_taskbar(true)
                        .always_on_top(true)
                        .focused(true)
                        .build()
                        {
                            Ok(window) => {
                                place_reminder_window(&window);
                                window.show().is_ok()
                            }
                            Err(_) => false,
                        }
                    };
                    if window_ready {
                        for note in &notes {
                            if let Some(id) = note["id"].as_str() {
                                let _ = client
                                    .post(format!("{backend_url}/notifications/{id}/ack"))
                                    .bearer_auth(token.trim())
                                    .send();
                            }
                        }
                    }
                    let _ = handle.emit("bai-reminder", ());
                    let _ = handle.emit_to("pet", "desktop-notification", &notes);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = event { desktop::refresh_hit_regions(window.app_handle(),window.label()); }
            if let tauri::WindowEvent::Destroyed = event { desktop::forget_pin(window.label()); }
            if ["quick", "capture", "pet"].contains(&window.label()) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    desktop::desktop_dismiss_label(window.app_handle(),window.label());
                    return;
                }
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Ok(mut allowed) = window.state::<drop_files::DroppedPaths>().0.lock() {
                    *allowed = paths.iter().cloned().collect();
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.emit("xiaoxi-close-learning", false);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("XiaoXi桌面应用启动失败");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(mut child) = handle.state::<Backend>().child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::migrate_legacy_data;

    #[test]
    fn migrates_app_data_and_keeps_the_webview_cache_behind() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("com.qinbai.baiagent");
        let current = root.path().join("XiaoXi_Agent");
        std::fs::create_dir_all(legacy.join("attachments")).unwrap();
        std::fs::create_dir_all(legacy.join("EBWebView")).unwrap();
        std::fs::write(legacy.join("bai.sqlite"), b"db").unwrap();
        std::fs::write(legacy.join("auth-token"), b"token").unwrap();
        std::fs::write(legacy.join("attachments/one.bin"), b"file").unwrap();
        std::fs::write(legacy.join("EBWebView/cache.bin"), b"cache").unwrap();
        assert!(migrate_legacy_data(&legacy, &current));
        assert_eq!(std::fs::read(current.join("bai.sqlite")).unwrap(), b"db");
        assert_eq!(
            std::fs::read(current.join("attachments/one.bin")).unwrap(),
            b"file"
        );
        assert!(!current.join("EBWebView").exists());
        assert!(legacy.join("EBWebView/cache.bin").exists());
        // A second launch sees the migrated database and does not move it again.
        assert!(migrate_legacy_data(&legacy, &current));
    }
}
