//! Local Windows speech. One worker owns COM/audio; selection changes invalidate queued work.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Media::Speech::*,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
    },
};

#[derive(Default)]
pub struct ReadAloud {
    epoch: AtomicU64,
    active: Mutex<Option<String>>,
    worker: Mutex<Option<mpsc::Sender<Job>>>,
}
struct Job {
    epoch: u64,
    selection_id: u64,
    id: String,
    text: String,
}

fn current(app: &tauri::AppHandle, job: &Job) -> bool {
    app.state::<ReadAloud>().epoch.load(Ordering::SeqCst) == job.epoch
        && app
            .state::<crate::selection::Selection>()
            .generation
            .load(Ordering::SeqCst)
            == job.selection_id
}
fn event(app: &tauri::AppHandle, job: &Job, phase: &str, error: &str) {
    let _ = app.emit_to(
        "selection",
        "selection-reading",
        serde_json::json!({
            "id":job.id, "selectionId":job.selection_id, "phase":phase, "error":error,
        }),
    );
}
pub fn cancel(app: &tauri::AppHandle) {
    let state = app.state::<ReadAloud>();
    let mut active = state.active.lock().unwrap();
    state.epoch.fetch_add(1, Ordering::SeqCst);
    *active = None;
}
#[tauri::command]
pub fn read_aloud_stop(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String) {
    if window.label() != "selection" {
        return;
    }
    let state = app.state::<ReadAloud>();
    let mut active = state.active.lock().unwrap();
    if active.as_deref() == Some(&id) {
        state.epoch.fetch_add(1, Ordering::SeqCst);
        *active = None;
    }
}
#[tauri::command]
pub fn read_aloud_start(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    selection_id: u64,
    id: String,
    text: String,
) -> Result<(), String> {
    if window.label() != "selection"
        || selection_id == 0
        || app
            .state::<crate::selection::Selection>()
            .generation
            .load(Ordering::SeqCst)
            != selection_id
    {
        return Err("选区已改变，请重新取词后朗读".into());
    }
    if text.trim().is_empty() || text.chars().count() > 50000 || id.is_empty() || id.len() > 80 {
        return Err("请提供 1–50,000 字符的朗读文字".into());
    }
    let state = app.state::<ReadAloud>();
    let mut worker = state.worker.lock().map_err(|_| "朗读服务不可用")?;
    if worker.is_none() {
        let (tx, rx) = mpsc::channel::<Job>();
        let handle = app.clone();
        std::thread::Builder::new()
            .name("xiaoxi-read-aloud".into())
            .spawn(move || {
                let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() };
                for job in rx {
                    if !current(&handle, &job) {
                        continue;
                    }
                    let result = if initialized.is_ok() {
                        speak(&handle, &job)
                    } else {
                        Err("Windows 朗读服务启动失败，请重试".into())
                    };
                    if current(&handle, &job) {
                        event(
                            &handle,
                            &job,
                            if result.is_ok() { "finished" } else { "error" },
                            result.as_ref().err().map(String::as_str).unwrap_or(""),
                        );
                    }
                }
                if initialized.is_ok() {
                    unsafe {
                        CoUninitialize();
                    }
                }
            })
            .map_err(|_| "无法启动朗读服务")?;
        *worker = Some(tx);
    }
    let mut active = state.active.lock().map_err(|_| "朗读状态不可用")?;
    let epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *active = Some(id.clone());
    worker
        .as_ref()
        .unwrap()
        .send(Job {
            epoch,
            selection_id,
            id,
            text,
        })
        .map_err(|_| "朗读服务已中断，请重新启动 XiaoXi".to_string())
}

fn speech_language(text: &str) -> Option<&'static str> {
    if text.chars().any(|c| ('\u{3040}'..='\u{30ff}').contains(&c)) {
        Some("411")
    } else if text.chars().any(|c| ('\u{ac00}'..='\u{d7af}').contains(&c)) {
        Some("412")
    } else if text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
        Some("804")
    } else if text.chars().any(|c| ('\u{0400}'..='\u{04ff}').contains(&c)) {
        Some("419")
    } else if text.chars().any(|c| c.is_ascii_alphabetic()) {
        Some("409")
    } else {
        None
    }
}
fn speak(app: &tauri::AppHandle, job: &Job) -> Result<(), String> {
    unsafe {
        let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "没有可用的 Windows 朗读语音，请检查系统语音设置")?;
        if let Some(language) = speech_language(&job.text) {
            let category: ISpObjectTokenCategory =
                CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| "无法读取 Windows 朗读语音")?;
            category
                .SetId(
                    w!("HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices"),
                    false,
                )
                .map_err(|_| "无法读取 Windows 朗读语音")?;
            let filter = HSTRING::from(format!("Language={language}"));
            let tokens = category
                .EnumTokens(&filter, PCWSTR::null())
                .map_err(|_| "无法读取 Windows 朗读语音")?;
            let mut token = None;
            let mut fetched = 0;
            tokens
                .Next(1, &mut token, Some(&mut fetched))
                .map_err(|_| "无法读取 Windows 朗读语音")?;
            let token =
                token.ok_or("未找到对应语言的朗读语音，请在 Windows 语音设置中添加该语言")?;
            voice
                .SetVoice(&token)
                .map_err(|_| "无法使用所选 Windows 朗读语音")?;
        }
        if !current(app, job) {
            return Ok(());
        }
        // Treat selected text as plain text, never as SAPI XML or a filename.
        voice
            .Speak(
                &HSTRING::from(&job.text),
                (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32,
                None,
            )
            .map_err(|_| "朗读未能开始，请检查 Windows 音频输出和语音设置")?;
        event(app, job, "speaking", "");
        loop {
            if !current(app, job) {
                let _ = voice.Speak(
                    PCWSTR::null(),
                    (SPF_ASYNC.0 | SPF_PURGEBEFORESPEAK.0) as u32,
                    None,
                );
                return Ok(());
            }
            let mut status = SPVOICESTATUS::default();
            voice
                .GetStatus(&mut status, std::ptr::null_mut())
                .map_err(|_| "无法读取朗读状态，请重试")?;
            if status.hrLastResult.is_err() {
                return Err("朗读中断，请检查音频输出后重试".into());
            }
            if status.dwRunningState == SPRS_DONE.0 as u32 {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}
