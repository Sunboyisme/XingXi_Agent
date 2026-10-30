//! A serialized, selection-only copy fallback. Clipboard handles are duplicated
//! before copying and restored only while the copied data is still current.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{DataExchange::*, Memory::*, Ole::*},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

static COPY_LOCK: Mutex<()> = Mutex::new(());
struct Clipboard;
impl Clipboard {
    unsafe fn open(owner: HWND) -> Result<Self, String> {
        unsafe { OpenClipboard(Some(owner)) }
            .map_err(|_| "剪贴板正在使用，请稍后重试".to_string())?;
        Ok(Self)
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}
struct Saved(Vec<(u32, HANDLE)>);
impl Drop for Saved {
    fn drop(&mut self) {
        for (format, handle) in self.0.drain(..) {
            unsafe {
                if [2, 9, 0x82].contains(&format) {
                    let _ = DeleteObject(HGDIOBJ(handle.0));
                } else if [14, 0x8e].contains(&format) {
                    let _ = DeleteEnhMetaFile(Some(HENHMETAFILE(handle.0)));
                } else {
                    let _ = GlobalFree(Some(HGLOBAL(handle.0)));
                }
            }
        }
    }
}
fn held(key: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(key.0 as i32) < 0 }
}
unsafe fn owner_is(foreground: usize) -> bool {
    unsafe {
        let Ok(owner) = GetClipboardOwner() else {
            return false;
        };
        let mut source = 0;
        let mut actual = 0;
        GetWindowThreadProcessId(HWND(foreground as *mut _), Some(&mut source));
        GetWindowThreadProcessId(owner, Some(&mut actual));
        source != 0 && source == actual
    }
}
pub fn copy_selected(foreground: usize, owner: usize) -> Result<String, String> {
    let _copy = COPY_LOCK
        .try_lock()
        .map_err(|_| "上次取词尚未完成".to_string())?;
    let deadline = Instant::now() + Duration::from_millis(500);
    while [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LBUTTON]
        .iter()
        .any(|key| held(*key))
    {
        if Instant::now() >= deadline {
            return Err("请松开快捷键后重新取词".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unsafe {
        if GetForegroundWindow().0 as usize != foreground {
            return Err("选区窗口已变化".into());
        }
        let mut saved = Saved(Vec::new());
        let before;
        {
            let _clipboard = Clipboard::open(HWND(owner as *mut _))?;
            let mut format = EnumClipboardFormats(0);
            let mut total = 0usize;
            while format != 0 {
                if saved.0.len() >= 128 {
                    return Err("原剪贴板格式过多，请稍后使用快捷键取词".into());
                }
                // Owner-rendered metafiles cannot be safely frozen as global memory.
                if [3, 0x80, 0x83].contains(&format) {
                    return Err("当前剪贴板格式无法安全保留，请使用支持无障碍取词的软件".into());
                }
                let original =
                    GetClipboardData(format).map_err(|_| "无法保存原剪贴板".to_string())?;
                if ![2, 9, 14, 0x82, 0x8e].contains(&format) {
                    total = total.saturating_add(GlobalSize(HGLOBAL(original.0)));
                    if total > 64 * 1024 * 1024 {
                        return Err("原剪贴板内容过大，已保留原内容，请先调整剪贴板后重试".into());
                    }
                }
                let duplicate =
                    OleDuplicateData(original, CLIPBOARD_FORMAT(format as u16), GMEM_MOVEABLE);
                if duplicate.is_invalid() {
                    return Err("无法保留原剪贴板格式".into());
                }
                saved.0.push((format, duplicate));
                format = EnumClipboardFormats(format);
            }
            before = GetClipboardSequenceNumber();
        }
        let mut class = [0u16; 128];
        let length = GetClassNameW(HWND(foreground as *mut _), &mut class);
        let terminal =
            String::from_utf16_lossy(&class[..length.max(0) as usize]).contains("CASCADIA");
        let keys: Vec<_> = if terminal {
            vec![VK_CONTROL, VK_SHIFT, VIRTUAL_KEY(0x43)]
        } else {
            vec![VK_CONTROL, VIRTUAL_KEY(0x43)]
        };
        let events: Vec<_> = keys
            .iter()
            .map(|key| (*key, false))
            .chain(keys.iter().rev().map(|key| (*key, true)))
            .map(|(key, up)| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: key,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                        ..Default::default()
                    },
                },
            })
            .collect();
        if GetClipboardSequenceNumber() != before
            || GetForegroundWindow().0 as usize != foreground
            || [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LBUTTON]
                .iter()
                .any(|key| held(*key))
        {
            return Err("选区或剪贴板已变化，请重试".into());
        }
        if SendInput(&events, std::mem::size_of::<INPUT>() as i32) != events.len() as u32 {
            let releases: Vec<_> = events.iter().skip(keys.len()).copied().collect();
            let _ = SendInput(&releases, std::mem::size_of::<INPUT>() as i32);
            return Err("当前软件未接受取词操作".into());
        }
        let deadline = Instant::now() + Duration::from_millis(700);
        while GetClipboardSequenceNumber() == before {
            if Instant::now() >= deadline {
                return Err("当前软件未提供选中文字".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let copied = GetClipboardSequenceNumber();
        if !owner_is(foreground) {
            return Err("剪贴板已被其他程序更新，请重新选择文字".into());
        }
        let deadline = Instant::now() + Duration::from_millis(700);
        let _clipboard = loop {
            match Clipboard::open(HWND(owner as *mut _)) {
                Ok(value) => break value,
                Err(error) => {
                    if Instant::now() >= deadline {
                        return Err(error);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        if GetClipboardSequenceNumber() != copied || !owner_is(foreground) {
            return Err("剪贴板已变化，请重新选择文字".into());
        }
        let text = (|| {
            let data = GetClipboardData(13).map_err(|_| "选区没有可读取的文字".to_string())?;
            let size = GlobalSize(HGLOBAL(data.0));
            if size > 200_002 {
                return Err("选中文字过长，请缩小选区".into());
            }
            let pointer = GlobalLock(HGLOBAL(data.0)) as *const u16;
            if pointer.is_null() {
                return Err("无法读取选中文字".into());
            }
            let slice = std::slice::from_raw_parts(pointer, size / 2);
            let end = slice.iter().position(|c| *c == 0).unwrap_or(slice.len());
            let value = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(HGLOBAL(data.0));
            Ok(value)
        })();
        EmptyClipboard().map_err(|_| "恢复剪贴板失败".to_string())?;
        while let Some((format, handle)) = saved.0.pop() {
            if SetClipboardData(format, Some(handle)).is_err() {
                saved.0.push((format, handle));
                return Err("恢复剪贴板格式失败".into());
            }
        }
        text
    }
}
