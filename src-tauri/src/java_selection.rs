//! Read-only bridge for JetBrains' Swing editor. Load only the foreground IDE's
//! bundled runtime, never change IDE/system accessibility settings or copy keys.
use std::{path::PathBuf, sync::mpsc, time::Duration};
use windows::{
    core::{PCSTR, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HMODULE, HWND},
        System::{LibraryLoader::*, Threading::*},
        UI::WindowsAndMessaging::*,
    },
};

type Context = i64;
#[repr(C)]
struct ContextInfo {
    name: [u16; 1024],
    description: [u16; 1024],
    role: [u16; 256],
    role_en: [u16; 256],
    states: [u16; 256],
    states_en: [u16; 256],
    index: i32,
    children: i32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    component: i32,
    action: i32,
    selection: i32,
    text: i32,
    interfaces: i32,
}
#[repr(C)]
struct SelectionInfo {
    start: i32,
    end: i32,
    text: [u16; 1024],
}
type Focus = unsafe extern "C" fn(HWND, *mut i32, *mut Context) -> i32;
type Info = unsafe extern "C" fn(i32, Context, *mut ContextInfo) -> i32;
type Selection = unsafe extern "C" fn(i32, Context, *mut SelectionInfo) -> i32;
type Range = unsafe extern "C" fn(i32, Context, i32, i32, *mut u16, i16) -> i32;
type Parent = unsafe extern "C" fn(i32, Context) -> Context;
type Release = unsafe extern "C" fn(i32, Context);
struct Bridge {
    _module: HMODULE,
    focus: Focus,
    info: Info,
    selection: Selection,
    range: Range,
    parent: Parent,
    release: Release,
}

fn runtime_path(source: isize) -> Option<PathBuf> {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(HWND(source as *mut _), Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let exe = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
        let name = exe.file_name()?.to_str()?.to_ascii_lowercase();
        if ![
            "pycharm64.exe",
            "idea64.exe",
            "webstorm64.exe",
            "clion64.exe",
            "goland64.exe",
            "rider64.exe",
            "datagrip64.exe",
        ]
        .contains(&name.as_str())
        {
            return None;
        }
        let dll = exe
            .parent()?
            .parent()?
            .join("jbr/bin/WindowsAccessBridge-64.dll");
        dll.is_file().then_some(dll)
    }
}

impl Bridge {
    fn load(path: &PathBuf) -> Option<Self> {
        unsafe {
            let path: Vec<u16> = path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let module = LoadLibraryExW(
                PCWSTR(path.as_ptr()),
                None,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
            .ok()?;
            macro_rules! symbol {
                ($name:literal, $kind:ty) => {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(
                        GetProcAddress(module, PCSTR(concat!($name, "\0").as_ptr()))?,
                    )
                };
            }
            let start = symbol!("Windows_run", unsafe extern "C" fn());
            let bridge = Self {
                _module: module,
                focus: symbol!("getAccessibleContextWithFocus", Focus),
                info: symbol!("getAccessibleContextInfo", Info),
                selection: symbol!("getAccessibleTextSelectionInfo", Selection),
                range: symbol!("getAccessibleTextRange", Range),
                parent: symbol!("getAccessibleParentFromContext", Parent),
                release: symbol!("releaseJavaObject", Release),
            };
            start();
            Some(bridge)
        }
    }
    fn selected(&self, source: isize) -> Option<String> {
        unsafe {
            if GetForegroundWindow().0 as isize != source {
                return None;
            }
            let mut vm = 0;
            let mut context = 0;
            if (self.focus)(HWND(source as *mut _), &mut vm, &mut context) == 0 {
                return None;
            }
            for _ in 0..8 {
                if context == 0 {
                    break;
                }
                let mut info: ContextInfo = std::mem::zeroed();
                if (self.info)(vm, context, &mut info) == 0 {
                    (self.release)(vm, context);
                    context = 0;
                    break;
                }
                let role = String::from_utf16_lossy(&info.role_en)
                    .trim_end_matches('\0')
                    .to_lowercase();
                if role.contains("password") {
                    (self.release)(vm, context);
                    return None;
                }
                let mut selection: SelectionInfo = std::mem::zeroed();
                if info.text != 0
                    && (self.selection)(vm, context, &mut selection) != 0
                    && selection.end > selection.start
                {
                    let length = selection.end - selection.start;
                    if selection.start < 0 || length > 1_000_000 {
                        (self.release)(vm, context);
                        return None;
                    }
                    let mut output = Vec::new();
                    let mut offset = 0;
                    let mut valid = true;
                    // The bridge's IPC packet holds at most 10,240 UTF-16 units.
                    while offset < length {
                        let count = (length - offset).min(10_000);
                        let mut text = vec![0u16; count as usize + 1];
                        if (self.range)(
                            vm,
                            context,
                            selection.start + offset,
                            selection.start + offset + count - 1,
                            text.as_mut_ptr(),
                            text.len() as i16,
                        ) == 0
                        {
                            valid = false;
                            break;
                        }
                        let end = text.iter().position(|c| *c == 0).unwrap_or(count as usize);
                        output.extend_from_slice(&text[..end]);
                        offset += count;
                    }
                    (self.release)(vm, context);
                    if !valid {
                        return None;
                    }
                    return Some(String::from_utf16_lossy(&output))
                        .filter(|text| !text.trim().is_empty());
                }
                let parent = (self.parent)(vm, context);
                (self.release)(vm, context);
                context = parent;
            }
            if context != 0 {
                (self.release)(vm, context);
            }
            None
        }
    }
}

pub struct JavaSelection(mpsc::SyncSender<(isize, mpsc::SyncSender<Option<String>>)>);
impl JavaSelection {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<(isize, mpsc::SyncSender<Option<String>>)>(1);
        std::thread::spawn(move || {
            let mut bridges = std::collections::HashMap::<PathBuf, Option<Bridge>>::new();
            loop {
                // Windows_run owns a message window and needs its thread to pump messages.
                unsafe {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                match receiver.recv_timeout(Duration::from_millis(16)) {
                    Ok((source, reply)) => {
                        let text = runtime_path(source).and_then(|path| {
                            let bridge = bridges
                                .entry(path.clone())
                                .or_insert_with(|| Bridge::load(&path));
                            bridge.as_ref().and_then(|bridge| bridge.selected(source))
                        });
                        let _ = reply.try_send(text);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        Self(sender)
    }
    pub fn selected(&self, source: isize) -> Option<String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.0.try_send((source, sender)).ok()?;
        receiver
            .recv_timeout(Duration::from_millis(350))
            .ok()
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_oracle_access_bridge_windows_abi() {
        assert_eq!(std::mem::size_of::<ContextInfo>(), 6188);
        assert_eq!(std::mem::size_of::<SelectionInfo>(), 2056);
        assert_eq!(std::mem::size_of::<Context>(), 8);
    }
}
