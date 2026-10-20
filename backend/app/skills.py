"""Imported skills are local executable configuration, never implicit authority."""

import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import signal
import subprocess
import zipfile
from pathlib import Path, PurePosixPath

import yaml
from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from . import config
from .db import Session, Skill, SkillRuntime, uid

MAX_BYTES = 20 * 1024 * 1024
SCRIPT_TIMEOUT = 60
active: dict[str, set[asyncio.Task]] = {}
RUNTIMES = {
    "python": ["python", "python3"],
    "node": ["node"],
    "powershell": ["pwsh", "powershell"],
    "bash": ["bash"],
}
EXTENSIONS = {
    ".py": "python",
    ".js": "node",
    ".mjs": "node",
    ".cjs": "node",
    ".ps1": "powershell",
    ".sh": "bash",
}


class SkillRead(BaseModel):
    id: str
    name: str
    description: str
    body: str
    files: list[str]
    enabled: bool
    scripts_allowed: bool
    model_config = {"from_attributes": True}


class SkillUpdate(BaseModel):
    enabled: bool | None = None
    scripts_allowed: bool | None = None


class ImportConfirm(BaseModel):
    preview_id: str
    replace_id: str | None = None


def root():
    value = config.DATA_DIR / "skills"
    value.mkdir(exist_ok=True)
    return value


def ensure_builtin():
    """Install the bundled example once; never replace or authorize a user's skill."""
    marker = root() / ".text-notes-installed"
    if marker.exists():
        return
    with Session() as db:
        existing = db.scalar(select(Skill).where(Skill.name == "text-notes"))
    if existing is None:
        folder = Path(__file__).parent / "builtin_skills" / "text-notes"
        files = [
            (p.relative_to(folder).as_posix(), p.read_bytes())
            for p in sorted(folder.rglob("*"))
            if p.is_file()
        ]
        candidate = preview(files)
        row = import_skill(ImportConfirm(preview_id=candidate["preview_id"]))
        with Session() as db:
            db.get(Skill, row.id).enabled = True
            db.commit()
    marker.write_text("1", encoding="utf-8")


def safe_path(name):
    name = name.replace("\\", "/")
    path = PurePosixPath(name)
    if (
        not name
        or path.name == ".preview.json"
        or path.is_absolute()
        or any(
            part in {".", ".."}
            or ":" in part
            or part.endswith((".", " "))
            or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)
            for part in path.parts
        )
        or "\x00" in name
    ):
        raise HTTPException(422, "技能包包含非法文件路径")
    return path.as_posix()


def require(db, key, enabled=False):
    row = db.get(Skill, key)
    if row is None:
        raise HTTPException(404, "技能不存在")
    if enabled and not row.enabled:
        raise HTTPException(409, "技能已停用")
    return row


def preview(files):
    unpacked = {}
    for name, data in files:
        if len(files) == 1 and name.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    entries = archive.infolist()
                    if (
                        len(entries) > 500
                        or sum(x.file_size for x in entries) > MAX_BYTES
                    ):
                        raise HTTPException(413, "技能包最多 500 个文件、20 MB")
                    for entry in entries:
                        if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                            raise HTTPException(422, "技能包不能包含符号链接")
                        if entry.is_dir():
                            safe_path(entry.filename)
                            continue
                        key = safe_path(entry.filename)
                        if key.casefold() in {x.casefold() for x in unpacked}:
                            raise HTTPException(422, "技能包包含重复文件")
                        unpacked[key] = archive.read(entry)
            except (zipfile.BadZipFile, RuntimeError):
                raise HTTPException(422, "无法读取技能 ZIP")
        else:
            key = safe_path(name)
            if key.casefold() in {x.casefold() for x in unpacked}:
                raise HTTPException(422, "技能包包含重复文件")
            unpacked[key] = data
    if len(unpacked) > 500 or sum(map(len, unpacked.values())) > MAX_BYTES:
        raise HTTPException(413, "技能包最多 500 个文件、20 MB")
    manifests = [key for key in unpacked if PurePosixPath(key).name == "SKILL.md"]
    if len(manifests) != 1:
        raise HTTPException(422, "请一次导入一个包含 SKILL.md 的技能包")
    manifest = manifests[0]
    prefix = manifest[: -len("SKILL.md")]
    if any(not key.startswith(prefix) for key in unpacked):
        raise HTTPException(422, "所有文件必须位于 SKILL.md 所在目录内")
    unpacked = {key[len(prefix) :]: value for key, value in unpacked.items()}
    try:
        content = unpacked["SKILL.md"].decode("utf-8-sig")
        if not content.startswith("---\n") and not content.startswith("---\r\n"):
            raise ValueError()
        _, front, body = re.split(r"(?m)^---\s*$", content, maxsplit=2)
        metadata = yaml.safe_load(front)
        name, description = metadata["name"], metadata["description"]
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name)
            or len(name) > 64
        ):
            raise ValueError()
        if (
            not isinstance(description, str)
            or not description.strip()
            or len(description) > 1024
            or len(body) > 40000
        ):
            raise ValueError()
    except (ValueError, KeyError, TypeError, UnicodeError, yaml.YAMLError):
        raise HTTPException(
            422,
            "SKILL.md 需要 YAML name（英文小写及短横线）和 description，正文不超过 40000 字符",
        )
    digest = hashlib.sha256()
    for key in sorted(unpacked):
        digest.update(key.encode() + b"\x00" + hashlib.sha256(unpacked[key]).digest())
    key = uid()
    folder = config.DATA_DIR / "skill-imports" / key
    folder.mkdir(parents=True)
    for path, data in unpacked.items():
        target = folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    details = {
        "preview_id": key,
        "name": name,
        "description": description.strip(),
        "body": body.strip(),
        "files": sorted(unpacked),
        "digest": digest.hexdigest(),
    }
    (folder / ".preview.json").write_text(json.dumps(details), "utf-8")
    with Session() as db:
        existing = db.scalar(select(Skill).where(Skill.name == name))
        details["existing_id"] = existing.id if existing else None
    return details


def import_skill(value):
    if not re.fullmatch(r"[a-f0-9-]{36}", value.preview_id):
        raise HTTPException(404, "导入预览不存在")
    folder = config.DATA_DIR / "skill-imports" / value.preview_id
    if not (folder / ".preview.json").is_file():
        raise HTTPException(404, "导入预览不存在，请重新选择")
    details = json.loads((folder / ".preview.json").read_text("utf-8"))
    with Session() as db:
        existing = db.scalar(select(Skill).where(Skill.name == details["name"]))
        if existing and existing.id != value.replace_id:
            raise HTTPException(409, "同名技能已存在，请明确选择替换")
        if value.replace_id and not existing:
            raise HTTPException(409, "待替换技能已改变，请重新预览")
        if existing and active.get(existing.id):
            raise HTTPException(409, "请先停止正在运行的技能")
        row = existing or Skill(id=uid(), name=details["name"])
        changed = existing is None or row.digest != details["digest"]
        target = root() / row.id
        # Stage first; rollback restores the previous package if committing fails.
        temporary = root() / (row.id + ".new")
        backup = root() / (row.id + ".old")
        shutil.copytree(folder, temporary, dirs_exist_ok=True)
        (temporary / ".preview.json").unlink()
        if target.exists():
            target.rename(backup)
        temporary.rename(target)
        try:
            for name in ("description", "body", "files", "digest"):
                setattr(row, name, details[name])
            if changed:
                row.enabled, row.scripts_allowed = False, False
            db.add(row)
            db.commit()
        except Exception:
            shutil.rmtree(target)
            if backup.exists():
                backup.rename(target)
            raise
        finally:
            if backup.exists() and target.exists():
                shutil.rmtree(backup)
        shutil.rmtree(folder)
        return SkillRead.model_validate(row)


def catalog():
    with Session() as db:
        return [
            {"id": r.id, "name": r.name, "description": r.description}
            for r in db.scalars(select(Skill).where(Skill.enabled.is_(True)))
        ]


def read_file(key, path="SKILL.md"):
    with Session() as db:
        row = require(db, key, enabled=True)
        path = safe_path(path)
        if path not in row.files:
            raise HTTPException(404, "文件不在技能包内")
        data = (root() / key / path).read_bytes()
        if len(data) > 200000:
            raise HTTPException(413, "参考文件过大，请使用脚本处理")
        try:
            return {
                "skill_id": key,
                "path": path,
                "text": data.decode("utf-8-sig"),
                "files": row.files,
            }
        except UnicodeError:
            raise HTTPException(422, "此文件不是文本，可用技能脚本处理")


def runtime_info():
    with Session() as db:
        configured = {r.name: r.path for r in db.scalars(select(SkillRuntime))}
    result = {}
    for name, commands in RUNTIMES.items():
        explicit = configured.get(name, "")
        found = (
            (
                str(Path(explicit).resolve())
                if explicit and Path(explicit).is_file()
                else ""
            )
            if explicit
            else next((p for cmd in commands if (p := shutil.which(cmd))), "")
        )
        # WindowsApps aliases are launchers, not usable unattended Python runtimes.
        if "windowsapps" in found.casefold():
            found = ""
        result[name] = {"path": explicit, "resolved": found, "available": bool(found)}
    return result


def stop(key):
    for task in list(active.get(key, set())):
        task.cancel()


async def close():
    tasks = [task for group in active.values() for task in group]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def windows_job(pid, memory_limit=None):
    """Kill-on-close Job Object owns descendants even after their parent exits."""
    import ctypes
    from ctypes import wintypes as w

    class Basic(ctypes.Structure):
        _fields_ = [
            ("ProcessTime", ctypes.c_int64),
            ("JobTime", ctypes.c_int64),
            ("Flags", w.DWORD),
            ("MinWorkingSet", ctypes.c_size_t),
            ("MaxWorkingSet", ctypes.c_size_t),
            ("ActiveLimit", w.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("Priority", w.DWORD),
            ("Scheduling", w.DWORD),
        ]

    class IO(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_uint64)
            for name in (
                "ReadOps",
                "WriteOps",
                "OtherOps",
                "ReadBytes",
                "WriteBytes",
                "OtherBytes",
            )
        ]

    class Extended(ctypes.Structure):
        _fields_ = [
            ("Basic", Basic),
            ("IO", IO),
            ("ProcessMemory", ctypes.c_size_t),
            ("JobMemory", ctypes.c_size_t),
            ("PeakProcess", ctypes.c_size_t),
            ("PeakJob", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.SetInformationJobObject.argtypes = [
        w.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        w.DWORD,
    ]
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    info = Extended()
    info.Basic.Flags = 0x2000
    if memory_limit:
        info.Basic.Flags |= 0x100
        info.ProcessMemory = memory_limit
    process = kernel.OpenProcess(0x0100 | 0x0001, False, pid)
    try:
        if (
            not handle
            or not process
            or not kernel.SetInformationJobObject(
                handle, 9, ctypes.byref(info), ctypes.sizeof(info)
            )
            or not kernel.AssignProcessToJobObject(handle, process)
        ):
            raise OSError("无法创建技能进程组")
    except Exception:
        if handle:
            kernel.CloseHandle(handle)
        raise
    finally:
        if process:
            kernel.CloseHandle(process)
    return lambda: kernel.CloseHandle(handle)


async def run_script(key, path, args, run_id):
    from . import artifacts

    with Session() as db:
        row = require(db, key, enabled=True)
        if not row.scripts_allowed:
            return {"error": "此技能尚未授权脚本执行，请在设置 → 技能中开启"}
        path = safe_path(path)
        runtime = EXTENSIONS.get(Path(path).suffix.lower())
        if path not in row.files or not path.startswith("scripts/") or not runtime:
            return {"error": "只能运行技能包 scripts/ 中支持的脚本"}
        digest = row.digest
    if (
        not isinstance(args, list)
        or len(args) > 100
        or any(not isinstance(x, str) or len(x) > 10000 or "\x00" in x for x in args)
    ):
        return {"error": "脚本参数必须是字符串数组"}
    executable = runtime_info()[runtime]["resolved"]
    if not executable:
        return {"error": f"缺少 {runtime} 运行环境，请安装或在技能设置中指定解释器路径"}
    work = config.DATA_DIR / "skill-runs" / run_id / key / digest
    if not work.exists():
        shutil.copytree(root() / key, work)
    output = work / "outputs"
    output.mkdir(exist_ok=True)
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper()
        in {
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "COMSPEC",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "LANG",
            "HOMEDRIVE",
            "HOMEPATH",
        }
    }
    env.update({"PYTHONIOENCODING": "utf-8", "XIAOXI_OUTPUT_DIR": str(output)})
    command = [executable]
    if runtime == "powershell":
        command += ["-NoProfile", "-NonInteractive", "-File"]
    command += [str(work / path), *args]
    task = asyncio.current_task()
    active.setdefault(key, set()).add(task)
    process, release = None, None
    readers = []

    async def drain(stream):
        kept = bytearray()
        total = 0
        while chunk := await stream.read(8192):
            total += len(chunk)
            if len(kept) < 24000:
                kept.extend(chunk[: 24000 - len(kept)])
        return kept.decode("utf-8", errors="replace") + (
            "\n[输出已截断]" if total > 24000 else ""
        )

    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=work,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **(
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt"
                else {"start_new_session": True}
            ),
        )
        if os.name == "nt":
            release = windows_job(process.pid)
        readers = [
            asyncio.create_task(drain(process.stdout)),
            asyncio.create_task(drain(process.stderr)),
        ]
        async with asyncio.timeout(SCRIPT_TIMEOUT):
            # returncode is set when the root exits, even if a descendant inherited its pipes.
            while process.returncode is None:
                await asyncio.sleep(0.02)
            if release:
                release()
                release = None
            elif os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            stdout, stderr = await asyncio.gather(*readers)
        files = []
        for file in sorted(output.rglob("*")):
            if file.is_symlink() or not file.resolve().is_relative_to(output.resolve()):
                continue
            if file.is_file() and len(files) < 30 and file.stat().st_size <= MAX_BYTES:
                files.append(artifacts.save_file(run_id, file.name, file.read_bytes()))
        result = {
            "exit_code": process.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "artifacts": files,
        }
        if process.returncode:
            result["error"] = "技能脚本执行失败，请查看退出码和错误输出；未自动重试"
        return result
    except TimeoutError:
        return {"error": "技能脚本超时，执行结果未知；未自动重试"}
    except asyncio.CancelledError:
        raise
    except OSError:
        return {"error": "无法启动技能脚本，请检查解释器及运行权限"}
    finally:
        if release:
            release()
        if process:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
        for reader in readers:
            if not reader.done():
                reader.cancel()
        if readers:
            await asyncio.gather(*readers, return_exceptions=True)
        active.get(key, set()).discard(task)
