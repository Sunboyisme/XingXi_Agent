use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Voice(pub Mutex<Option<Recording>>);
pub struct Recording {
    id: String,
    stop: Arc<AtomicBool>,
    audio: Vec<u8>,
    gesture: Option<u64>,
}

fn event(app: &tauri::AppHandle, id: &str, phase: &str, seconds: f64, level: f32, error: &str) {
    let _ = app.emit_to(
        "quick",
        "desktop-voice",
        serde_json::json!({"id":id,"phase":phase,"seconds":seconds,"level":level,"error":error}),
    );
}

#[tauri::command]
pub fn voice_start(app: tauri::AppHandle, gesture: Option<u64>) -> Result<String, String> {
    if gesture.is_some_and(|id| !crate::desktop_input::gesture_held(id)) {
        return Err("录音手势已结束".into());
    }
    let state = app.state::<Voice>();
    let mut active = state.0.lock().map_err(|_| "录音状态不可用")?;
    if gesture.is_some_and(|id| !crate::desktop_input::gesture_held(id)) {
        return Err("录音手势已结束".into());
    }
    if let Some(old) = active.as_ref() {
        old.stop.store(true, Ordering::SeqCst);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    *active = Some(Recording {
        id: id.clone(),
        stop: stop.clone(),
        audio: vec![],
        gesture,
    });
    drop(active);
    drop(state);
    let key = id.clone();
    std::thread::spawn(move || {
        let result = record(&app, &key, &stop);
        if let Err(error) = result {
            event(&app, &key, "error", 0.0, 0.0, &error);
        }
    });
    Ok(id)
}
pub fn stop_gesture(app: &tauri::AppHandle, gesture: u64) {
    if let Some(r) = app
        .state::<Voice>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .filter(|r| r.gesture == Some(gesture))
    {
        r.stop.store(true, Ordering::SeqCst);
    }
}

fn record(app: &tauri::AppHandle, id: &str, stop: &AtomicBool) -> Result<(), String> {
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("没有可用麦克风，请检查系统录音设置")?;
    let supported = device
        .default_input_config()
        .map_err(|_| "无法访问麦克风，请检查 Windows 麦克风权限")?;
    let rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let failure = Arc::new(Mutex::new(String::new()));
    let errors = failure.clone();
    let on_error = move |_error| {
        if let Ok(mut error) = errors.lock() {
            *error = "麦克风已断开或录音设备不可用".into();
        }
    };
    let input = samples.clone();
    let max = rate as usize * 120;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| collect(data.iter().copied(), channels, max, &input),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                collect(
                    data.iter().map(|v| *v as f32 / 32768.0),
                    channels,
                    max,
                    &input,
                )
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                collect(
                    data.iter().map(|v| (*v as f32 - 32768.0) / 32768.0),
                    channels,
                    max,
                    &input,
                )
            },
            on_error,
            None,
        ),
        _ => return Err("当前麦克风的音频格式暂不支持，请更换默认录音设备".into()),
    }
    .map_err(|_| "麦克风启动失败，请检查录音权限及设备占用")?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    stream.play().map_err(|_| "无法开始录音")?;
    let started = Instant::now();
    while !stop.load(Ordering::SeqCst) && started.elapsed().as_secs() < 120 {
        if !failure.lock().unwrap().is_empty() {
            return Err(failure.lock().unwrap().clone());
        }
        let data = samples.lock().unwrap();
        let recent = &data[data.len().saturating_sub(rate as usize / 10)..];
        let level = (recent.iter().map(|v| v * v).sum::<f32>() / recent.len().max(1) as f32).sqrt();
        event(
            app,
            id,
            "recording",
            started.elapsed().as_secs_f64(),
            (level * 6.0).min(1.0),
            "",
        );
        drop(data);
        std::thread::sleep(Duration::from_millis(80));
    }
    drop(stream);
    let data = samples.lock().unwrap();
    let length = (data.len() as u64 * 16000 / rate as u64) as usize;
    let mut output = Cursor::new(Vec::new());
    {
        let mut wav = hound::WavWriter::new(
            &mut output,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|_| "无法整理录音")?;
        for index in 0..length {
            let point = index as f64 * rate as f64 / 16000.0;
            let a = point.floor() as usize;
            let ratio = (point - a as f64) as f32;
            let value = data[a] * (1.0 - ratio) + data[(a + 1).min(data.len() - 1)] * ratio;
            wav.write_sample((value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .map_err(|_| "无法整理录音")?;
        }
        wav.finalize().map_err(|_| "无法完成录音")?;
    }
    let state = app.state::<Voice>();
    let mut current = state.0.lock().unwrap();
    if let Some(recording) = current.as_mut().filter(|r| r.id == id) {
        recording.audio = output.into_inner();
        event(app, id, "ready", length as f64 / 16000.0, 0.0, "");
    }
    Ok(())
}

fn collect(
    values: impl Iterator<Item = f32>,
    channels: usize,
    max: usize,
    input: &Mutex<Vec<f32>>,
) {
    let mut samples = input.lock().unwrap();
    let mut sum = 0.0;
    let mut n = 0;
    for sample in values {
        sum += sample;
        n += 1;
        if n == channels {
            if samples.len() < max {
                samples.push(sum / channels as f32);
            }
            sum = 0.0;
            n = 0;
        }
    }
}

#[tauri::command]
pub fn voice_stop(state: tauri::State<'_, Voice>, id: Option<String>) {
    if let Some(r) = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .filter(|r| id.as_ref().is_none_or(|id| r.id == *id))
    {
        r.stop.store(true, Ordering::SeqCst);
    }
}
#[tauri::command]
pub fn voice_cancel(state: tauri::State<'_, Voice>, id: Option<String>) {
    let mut current = state.0.lock().unwrap();
    if id
        .as_ref()
        .is_some_and(|key| current.as_ref().is_none_or(|r| r.id != *key))
    {
        return;
    }
    if let Some(r) = current.take() {
        r.stop.store(true, Ordering::SeqCst);
    }
}
#[tauri::command]
pub fn voice_audio_get(
    state: tauri::State<'_, Voice>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let current = state.0.lock().unwrap();
    let r = current
        .as_ref()
        .filter(|r| r.id == id && !r.audio.is_empty())
        .ok_or("录音已取消或尚未完成")?;
    Ok(tauri::ipc::Response::new(r.audio.clone()))
}
