use serde::Serialize;
use std::{collections::HashSet, io::Read, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};

#[derive(Default)]
pub struct DroppedPaths(pub Mutex<HashSet<PathBuf>>);

#[derive(Serialize)]
pub struct DropFile {
    path: String,
    name: String,
    directory: bool,
    relative_path: String,
    bytes: Vec<u8>,
    last_modified: u64,
}

fn actual(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err("请拖入本机文件或文件夹".into()); }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))) {
            return Err("仅支持盘符开头的本机路径，不支持网络共享或设备路径".into());
        }
    }
    // Only the item itself is checked. Parent folders may legitimately be
    // junctions, e.g. a user profile folder mapped to another name; every
    // entry inside a dropped folder is checked again as it is collected.
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "文件或目录已无法访问")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("请拖入实际文件或文件夹，不支持快捷链接或未下载到本机的云文件".into());
        }
    }
    if metadata.file_type().is_symlink() { return Err("不支持链接".into()); }
    Ok(path.to_path_buf())
}

fn collect(path: &Path, parent: &str, recursive: bool, depth: usize, rows: &mut Vec<DropFile>, total: &mut u64, visited: &mut usize, deadline: Instant) -> Result<(), String> {
    *visited += 1;
    if *visited > 10_000 || Instant::now() > deadline { return Err("文件夹内容过多，读取已停止；请使用精简的技能文件夹".into()); }
    actual(path)?;
    if depth > 20 { return Err("文件夹层级过深".into()); }
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let relative_path = if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") };
    let directory = path.is_dir();
    if directory && recursive {
        for item in std::fs::read_dir(path).map_err(|_| "无法读取文件夹")? {
            collect(&item.map_err(|_| "无法读取文件夹项目")?.path(), &relative_path, true, depth + 1, rows, total, visited, deadline)?;
        }
        return Ok(());
    }
    let bytes = if directory { Vec::new() } else {
        let mut file = std::fs::File::open(path).map_err(|_| "无法读取文件")?;
        let metadata = file.metadata().map_err(|_| "无法读取文件")?;
        if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 { return Err("单个文件不能超过 20 MB".into()); }
        let mut bytes = Vec::new();
        (&mut file).take(20 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "无法读取文件")?;
        let after = file.metadata().map_err(|_| "无法读取文件")?;
        if bytes.len() > 20 * 1024 * 1024 { return Err("文件在读取时超过 20 MB，已停止读取".into()); }
        if metadata.len() != after.len() || metadata.modified().ok() != after.modified().ok() || bytes.len() as u64 != after.len() {
            return Err("文件在读取时发生变化，请保存后重新拖入".into());
        }
        *total += bytes.len() as u64;
        if recursive && *total > 20 * 1024 * 1024 { return Err("一次最多拖入 500 个文件、共 20 MB，请分批添加".into()); }
        bytes
    };
    if rows.len() >= 500 { return Err("最多读取 500 个文件".into()); }
    let last_modified = std::fs::metadata(path).ok().and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64).unwrap_or(0);
    rows.push(DropFile { path: path.to_string_lossy().into_owned(), name, directory, relative_path, bytes, last_modified });
    Ok(())
}

#[tauri::command]
pub async fn read_dropped_files(state: tauri::State<'_, DroppedPaths>, paths: Vec<String>, recursive: bool, folders_only: Option<bool>) -> Result<Vec<DropFile>, String> {
    let requested: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let folders_only = folders_only.unwrap_or(false);
    let limit = if folders_only { 20 } else if recursive { 500 } else { 4 };
    if requested.len() > limit { return Err("拖入项目过多，请分批添加".into()); }
    {
        let mut allowed = state.0.lock().map_err(|_| "拖入文件状态不可用")?;
        if requested.is_empty() || requested.iter().any(|path| !allowed.contains(path)) { return Err("请重新拖入文件或文件夹".into()); }
        for path in &requested { allowed.remove(path); }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut rows = Vec::new();
        let mut total = 0;
        let mut visited = 0;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = HashSet::new();
        for path in requested {
            if folders_only && !path.is_dir() {
                return Err("请拖入本地文件夹；单个文件可在项目资料库中添加".into());
            }
            if seen.insert(path.clone()) { collect(&path, "", recursive && !folders_only, 0, &mut rows, &mut total, &mut visited, deadline)?; }
        }
        Ok(rows)
    }).await.map_err(|_| "读取拖入文件失败".to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::actual;

    #[test]
    fn files_below_a_junction_are_accepted_but_the_junction_itself_is_not() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("note.txt"), b"text").unwrap();
        let link = root.path().join("profile");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(actual(&link.join("note.txt")).is_ok());
        assert!(actual(&link).is_err());
    }
}
