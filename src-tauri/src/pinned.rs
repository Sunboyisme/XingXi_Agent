//! Image-only pinned windows. Image bytes never enter the conversation database.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Cursor,
    sync::{LazyLock, Mutex},
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 64 * 1024 * 1024;
#[derive(Clone)]
struct PinnedImage {
    data_url: String,
    original_url: String,
    width: u32,
    height: u32,
    scale: f64,
    revision: u64,
}
static IMAGES: LazyLock<Mutex<HashMap<String, PinnedImage>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn menu_snapshot(window: &tauri::WebviewWindow) -> Result<(u32, u32, f64, u64), String> {
    IMAGES
        .lock()
        .unwrap()
        .get(window.label())
        .map(|image| (image.width, image.height, image.scale, image.revision))
        .ok_or("贴图已结束".into())
}
pub(crate) fn is_current(label: &str, revision: u64) -> bool {
    IMAGES
        .lock()
        .unwrap()
        .get(label)
        .is_some_and(|image| image.revision == revision)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInfo {
    data_url: String,
    original_url: Option<String>,
    width: u32,
    height: u32,
    scale: f64,
    revision: u64,
    dpi: f64,
}
#[derive(Serialize)]
pub struct Geometry {
    scale: f64,
    dpi: f64,
}

fn image_for(window: &tauri::WebviewWindow) -> Result<PinnedImage, String> {
    IMAGES
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or_else(|| "贴图已结束".to_string())
}
fn info(window: &tauri::WebviewWindow) -> Result<PinInfo, String> {
    let image = image_for(window)?;
    Ok(PinInfo {
        original_url: (image.original_url != image.data_url).then_some(image.original_url),
        data_url: image.data_url,
        width: image.width,
        height: image.height,
        scale: image.scale,
        revision: image.revision,
        dpi: window.scale_factor().map_err(|e| e.to_string())?,
    })
}
fn validate_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || width as u64 * height as u64 > MAX_PIXELS
    {
        return Err("图片尺寸过大，请使用不超过 6400 万像素的图片".into());
    }
    Ok(())
}
fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    if bytes.len() > MAX_BYTES {
        return Err("图片不能超过 32 MB".into());
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法读取图片格式")?;
    let (width, height) = reader.into_dimensions().map_err(|_| "无法读取图片尺寸")?;
    validate_size(width, height)?;
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法读取图片格式")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "图片无法解码，请选择 PNG、JPEG、WebP 或 BMP 图片".into())
}
fn png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "无法生成图片")?;
    let bytes = output.into_inner();
    if bytes.len() > MAX_BYTES {
        return Err("处理后的图片超过 32 MB，请缩小图片后再试".into());
    }
    Ok(bytes)
}
fn data_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("无效图片")?;
    if data.len() > MAX_BYTES * 4 / 3 + 8 {
        return Err("图片不能超过 32 MB".into());
    }
    STANDARD.decode(data).map_err(|_| "无效图片".into())
}
fn from_bytes(bytes: &[u8]) -> Result<PinnedImage, String> {
    let image = decode(bytes)?;
    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(png(&image)?));
    Ok(PinnedImage {
        original_url: data_url.clone(),
        data_url,
        width: image.width(),
        height: image.height(),
        scale: 1.0,
        revision: 1,
    })
}

pub fn create(app: &tauri::AppHandle, data_url: String, x: i32, y: i32) -> Result<(), String> {
    let image = from_bytes(&data_bytes(&data_url)?)?;
    let label = format!("pin-{}", uuid::Uuid::new_v4());
    IMAGES.lock().unwrap().insert(label.clone(), image);
    let result = (|| {
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?view={label}").into()),
        )
        .title("XiaoXi · 贴图")
        .inner_size(320.0, 180.0)
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
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        if let Err(error) = resize(&window, 1, 0.0, false, 0.0, 0.0) {
            let _ = window.close();
            return Err(error);
        }
        window.show().map_err(|e| e.to_string())
    })();
    if result.is_err() {
        forget(&label);
    }
    result
}
pub fn forget(label: &str) {
    IMAGES.lock().unwrap().remove(label);
}
pub fn show_all(app: &tauri::AppHandle) {
    let labels: Vec<_> = IMAGES.lock().unwrap().keys().cloned().collect();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
        }
    }
}
#[tauri::command]
pub fn pinned_info(window: tauri::WebviewWindow) -> Result<PinInfo, String> {
    info(&window)
}

fn resize(
    window: &tauri::WebviewWindow,
    revision: u64,
    requested: f64,
    editing: bool,
    anchor_x: f64,
    anchor_y: f64,
) -> Result<Geometry, String> {
    if ![requested, anchor_x, anchor_y]
        .iter()
        .all(|n| n.is_finite())
        || requested < 0.0
    {
        return Err("无效缩放比例".into());
    }
    let image = image_for(window)?;
    if image.revision != revision {
        return Err("图片已变化，请重新操作".into());
    }
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("显示器不可用")?;
    let area = monitor.work_area();
    let dpi = window.scale_factor().map_err(|e| e.to_string())?;
    let top = if editing { 44.0 } else { 8.0 } * dpi;
    let bottom = if editing { 104.0 } else { 8.0 } * dpi;
    let fit = ((area.size.width as f64 - 16.0 * dpi) / image.width as f64)
        .min((area.size.height as f64 - top - bottom) / image.height as f64)
        .max(0.001);
    let scale = if requested == 0.0 {
        fit.min(1.0)
    } else {
        requested.clamp(0.05, 4.0).min(fit)
    };
    let width = (image.width as f64 * scale + 16.0 * dpi)
        .round()
        .max(if editing { 360.0 } else { 112.0 } * dpi)
        .min(area.size.width as f64) as u32;
    let height = (image.height as f64 * scale + top + bottom)
        .round()
        .max(if editing { 240.0 } else { 80.0 } * dpi)
        .min(area.size.height as f64) as u32;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let old = window.outer_size().map_err(|e| e.to_string())?;
    let x = (position.x as f64 + anchor_x.clamp(0.0, 1.0) * (old.width as f64 - width as f64))
        .round() as i32;
    let y = (position.y as f64 + anchor_y.clamp(0.0, 1.0) * (old.height as f64 - height as f64))
        .round() as i32;
    window
        .set_size(PhysicalSize::new(width.max(1), height.max(1)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            x.clamp(
                area.position.x,
                area.position.x + area.size.width.saturating_sub(width) as i32,
            ),
            y.clamp(
                area.position.y,
                area.position.y + area.size.height.saturating_sub(height) as i32,
            ),
        ))
        .map_err(|e| e.to_string())?;
    if let Some(current) = IMAGES.lock().unwrap().get_mut(window.label()) {
        current.scale = scale;
    }
    Ok(Geometry { scale, dpi })
}
#[tauri::command]
pub fn pinned_resize(
    window: tauri::WebviewWindow,
    revision: u64,
    scale: f64,
    editing: bool,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
) -> Result<Geometry, String> {
    resize(
        &window,
        revision,
        scale,
        editing,
        anchor_x.unwrap_or(0.5),
        anchor_y.unwrap_or(0.5),
    )
}
#[tauri::command]
pub async fn pinned_update(
    window: tauri::WebviewWindow,
    revision: u64,
    data_url: String,
) -> Result<PinInfo, String> {
    let previous = image_for(&window)?;
    if previous.revision != revision {
        return Err("图片已变化，请重新操作".into());
    }
    let mut next =
        tauri::async_runtime::spawn_blocking(move || from_bytes(&data_bytes(&data_url)?))
            .await
            .map_err(|e| e.to_string())??;
    {
        let mut images = IMAGES.lock().unwrap();
        let current = images
            .get(window.label())
            .filter(|image| image.revision == revision)
            .ok_or("图片已变化，请重新操作")?;
        next.original_url = current.original_url.clone();
        next.revision = current.revision + 1;
        next.scale = current.scale;
        images.insert(window.label().into(), next.clone());
    }
    resize(&window, next.revision, next.scale, false, 0.5, 0.5)?;
    info(&window)
}
#[tauri::command]
pub async fn pinned_replace(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    revision: u64,
    source: String,
) -> Result<Option<PinInfo>, String> {
    image_for(&window)?;
    let next = match source.as_str() {
        "clipboard" => {
            let clipboard = app
                .clipboard()
                .read_image()
                .map_err(|_| "剪贴板中没有可用图片")?;
            validate_size(clipboard.width(), clipboard.height())?;
            let image = image::RgbaImage::from_raw(
                clipboard.width(),
                clipboard.height(),
                clipboard.rgba().to_vec(),
            )
            .ok_or("剪贴板图片无效")?;
            tauri::async_runtime::spawn_blocking(move || {
                from_bytes(&png(&DynamicImage::ImageRgba8(image))?)
            })
            .await
            .map_err(|e| e.to_string())??
        }
        "file" => {
            let _dialog = crate::desktop::NativeDialog::new(&app);
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_parent(&window)
                .set_title("替换贴图")
                .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp"])
                .pick_file()
                .await
            else {
                return Ok(None);
            };
            let path = file.path().to_path_buf();
            tauri::async_runtime::spawn_blocking(move || {
                if std::fs::metadata(&path)
                    .map_err(|_| "无法读取图片文件")?
                    .len()
                    > MAX_BYTES as u64
                {
                    return Err("图片不能超过 32 MB".into());
                }
                from_bytes(&std::fs::read(path).map_err(|_| "无法读取图片文件")?)
            })
            .await
            .map_err(|e| e.to_string())??
        }
        _ => return Err("未知图片来源".into()),
    };
    let mut next = next;
    {
        let mut images = IMAGES.lock().unwrap();
        let current = images
            .get(window.label())
            .filter(|image| image.revision == revision)
            .ok_or("图片已变化，请重新操作")?;
        next.revision = current.revision + 1;
        images.insert(window.label().into(), next.clone());
    }
    resize(&window, next.revision, 0.0, false, 0.5, 0.5)?;
    info(&window).map(Some)
}
#[tauri::command]
pub async fn pinned_export(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    revision: u64,
    action: String,
    original_size: bool,
) -> Result<bool, String> {
    let image = image_for(&window)?;
    if image.revision != revision {
        return Err("图片已变化，请重新操作".into());
    }
    match action.as_str() {
        "copy" => {
            tauri::async_runtime::spawn_blocking(move || {
                let mut decoded = decode(&data_bytes(&image.data_url)?)?;
                if !original_size {
                    let width = (image.width as f64 * image.scale).round().max(1.0) as u32;
                    let height = (image.height as f64 * image.scale).round().max(1.0) as u32;
                    validate_size(width, height)?;
                    decoded = decoded.resize_exact(
                        width,
                        height,
                        image::imageops::FilterType::CatmullRom,
                    );
                }
                let rgba = decoded.into_rgba8();
                app.clipboard()
                    .write_image(&tauri::image::Image::new_owned(
                        rgba.as_raw().clone(),
                        rgba.width(),
                        rgba.height(),
                    ))
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        "save" => {
            let _dialog = crate::desktop::NativeDialog::new(&app);
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_parent(&window)
                .set_file_name("XiaoXi贴图.png")
                .add_filter("PNG", &["png"])
                .save_file()
                .await
            else {
                return Ok(false);
            };
            if image_for(&window)?.revision != revision {
                return Err("图片已变化，请重新保存".into());
            }
            let path = file.path().to_path_buf();
            tauri::async_runtime::spawn_blocking(move || {
                std::fs::write(path, data_bytes(&image.data_url)?).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        _ => return Err("未知图片操作".into()),
    }
    Ok(true)
}
