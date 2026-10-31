use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
pub async fn common_text_copy_image(app: tauri::AppHandle, asset_id: String) -> Result<(), String> {
    if uuid::Uuid::parse_str(&asset_id).is_err() {
        return Err("图片编号无效".into());
    }
    let connection = crate::backend_config(app.state::<crate::Backend>())?;
    let image = tauri::async_runtime::spawn_blocking(move || {
        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| "图片服务不可用")?
            .get(format!(
                "{}/common-text-assets/{}/content",
                connection.url, asset_id
            ))
            .bearer_auth(connection.token)
            .send()
            .map_err(|_| "读取图片失败，请重试")?
            .error_for_status()
            .map_err(|_| "图片不存在或服务暂不可用")?;
        let bytes = response.bytes().map_err(|_| "读取图片失败")?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("图片过大".to_string());
        }
        let image = image::load_from_memory(&bytes)
            .map_err(|_| "无法读取图片")?
            .into_rgba8();
        Ok(image)
    })
    .await
    .map_err(|_| "读取图片失败".to_string())??;
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(
            image.as_raw().clone(),
            image.width(),
            image.height(),
        ))
        .map_err(|_| "复制图片失败，请重试".to_string())
}
