//! Keep desktop navigation until the main webview acknowledges receipt.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Navigation {
    serial: AtomicU64,
    pending: Mutex<Option<Request>>,
}

#[derive(Clone, Serialize)]
pub struct Request {
    id: u64,
    #[serde(flatten)]
    payload: serde_json::Value,
}

pub fn send(app: &tauri::AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let state = app.state::<Navigation>();
    let mut pending = state.pending.lock().map_err(|_| "导航状态不可用")?;
    let request = Request {
        id: state.serial.fetch_add(1, Ordering::SeqCst) + 1,
        payload,
    };
    *pending = Some(request.clone());
    drop(pending);
    app.emit_to("main", "desktop-navigate", request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_navigation_pending(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<Request>, String> {
    if window.label() != "main" {
        return Err("仅主窗口可读取导航请求".into());
    }
    let state = app.state::<Navigation>();
    let value = state.pending.lock().map_err(|_| "导航状态不可用")?.clone();
    Ok(value)
}

#[tauri::command]
pub fn desktop_navigation_ack(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可确认导航请求".into());
    }
    let state = app.state::<Navigation>();
    let mut pending = state.pending.lock().map_err(|_| "导航状态不可用")?;
    if pending.as_ref().is_some_and(|request| request.id == id) {
        pending.take();
    }
    Ok(())
}
