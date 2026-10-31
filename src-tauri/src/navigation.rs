//! Keep desktop navigation until the main webview acknowledges receipt.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Navigation {
    serial: AtomicU64,
    pending: Mutex<VecDeque<Request>>,
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
    pending.push_back(request);
    let first = pending.front().cloned();
    drop(pending);
    // The queue is authoritative: an emission failure must not discard an image
    // whose sender has already handed it off. Startup/focus reads recover delivery.
    if let Some(first) = first {
        let _ = app.emit_to("main", "desktop-navigate", first);
    }
    Ok(())
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
    let value = state
        .pending
        .lock()
        .map_err(|_| "导航状态不可用")?
        .front()
        .cloned();
    Ok(value)
}

/// Return the next request so queue delivery does not depend on another event.
#[tauri::command]
pub fn desktop_navigation_ack(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u64,
) -> Result<Option<Request>, String> {
    if window.label() != "main" {
        return Err("仅主窗口可确认导航请求".into());
    }
    let state = app.state::<Navigation>();
    let mut pending = state.pending.lock().map_err(|_| "导航状态不可用")?;
    if pending.front().is_some_and(|request| request.id == id) {
        pending.pop_front();
    }
    Ok(pending.front().cloned())
}
