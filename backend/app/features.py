"""0.1.3 endpoints, included under the existing authenticated API router."""

from typing import Annotated
from datetime import date, timedelta

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from . import artifacts, plans, skills, office
from . import calendar_service as calendar
from .db import Run, Session, Skill, SkillRuntime, PlanDayOrder
from .config import PROFILE_ID

router = APIRouter()


@router.get("/plans", response_model=list[plans.PlanRead])
def plan_list(start: str | None = None, end: str | None = None, timezone: str | None = None, include_deleted: bool = False):
    try:
        return plans.list_events(start, end, timezone, include_deleted)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.post("/plans", response_model=plans.PlanRead)
def plan_create(value: plans.PlanWrite):
    return plans.create_events([value])[0]


@router.post("/plans/batch", response_model=list[plans.PlanRead])
def plan_batch(value: plans.PlanBatch):
    return plans.create_events(value.events)


class DayOrderWrite(BaseModel):
    day: date
    timezone: str
    keys: list[str] = Field(default_factory=list, max_length=5000)


@router.get("/plans/order")
def day_orders(start: date, end: date, timezone: str):
    from zoneinfo import ZoneInfo
    try:
        ZoneInfo(timezone)
    except (KeyError, ValueError):
        raise HTTPException(422, "无效时区") from None
    if not 0 < (end - start).days <= 370:
        raise HTTPException(422, "日期范围须为1–370天")
    with Session() as db:
        return {row.day: row.keys for row in db.scalars(select(PlanDayOrder).where(
            PlanDayOrder.profile_id == PROFILE_ID, PlanDayOrder.timezone == timezone,
            PlanDayOrder.day >= start.isoformat(), PlanDayOrder.day < end.isoformat()))}


@router.put("/plans/order")
def save_day_order(value: DayOrderWrite):
    with plans.lock, Session() as db:
        events = plans.list_events(value.day.isoformat(), (value.day + timedelta(days=1)).isoformat(), value.timezone)
        valid = {event["id"] + ":" + event["occurrence_start"] for event in events}
        if len(set(value.keys)) != len(value.keys) or not set(value.keys) <= valid:
            raise HTTPException(409, "当天计划已经变化，请刷新后重新排序")
        row = db.scalar(select(PlanDayOrder).where(PlanDayOrder.profile_id == PROFILE_ID,
             PlanDayOrder.day == value.day.isoformat(), PlanDayOrder.timezone == value.timezone))
        if row and not value.keys:
            db.delete(row)
        elif value.keys:
            if row is None:
                row = PlanDayOrder(day=value.day.isoformat(), timezone=value.timezone)
                db.add(row)
            row.keys = value.keys
        db.commit()
        return {"day": value.day.isoformat(), "keys": value.keys}


@router.put("/plans/{plan_id}", response_model=plans.PlanRead)
def plan_update(plan_id: str, value: plans.PlanUpdate):
    return plans.update_event(plan_id, value)


@router.get("/plans/{plan_id}", response_model=plans.PlanRead)
def plan_read(plan_id: str, occurrence_start: str | None = None):
    with Session() as db:
        row = plans.find(db, plan_id)
        return plans.read_occurrence(db, row, occurrence_start) if occurrence_start else plans.serialize(db, row)


@router.post("/plans/{plan_id}/action", response_model=plans.PlanRead)
def plan_action(plan_id: str, value: plans.PlanAction):
    return plans.act(plan_id, value)


@router.delete("/plans/{plan_id}")
def plan_delete(plan_id: str):
    plans.delete_event(plan_id)
    return {"deleted": True}


@router.get("/calendar/events", response_model=list[calendar.EventRead])
def calendar_list(start: str | None = None, end: str | None = None):
    try:
        return calendar.list_events(start, end)
    except ValueError:
        raise HTTPException(422, "请提供有效的起止日期")


@router.post("/calendar/events", response_model=calendar.EventRead)
def calendar_create(value: calendar.EventWrite):
    return calendar.create_events([value])[0]


@router.post("/calendar/events/batch", response_model=list[calendar.EventRead])
def calendar_batch(value: calendar.EventBatch):
    return calendar.create_events(value.events)


@router.put("/calendar/events/{event_id}", response_model=calendar.EventRead)
def calendar_update(event_id: str, value: calendar.EventWrite):
    return calendar.update_event(event_id, value)


@router.delete("/calendar/events/{event_id}")
def calendar_delete(event_id: str):
    calendar.delete_event(event_id)
    return {"deleted": True}


@router.get("/skills", response_model=list[skills.SkillRead])
def skill_list():
    with Session() as db:
        return list(db.scalars(select(Skill).order_by(Skill.name)))


class SkillPreview(BaseModel):
    preview_id: str
    name: str
    description: str
    body: str
    files: list[str]
    digest: str
    existing_id: str | None = None


@router.post("/skills/preview", response_model=SkillPreview)
async def skill_preview(files: Annotated[list[UploadFile], File()]):
    if not files or len(files) > 500:
        raise HTTPException(413, "一次最多选择 500 个文件")
    values, total = [], 0
    for file in files:
        data = await file.read(skills.MAX_BYTES + 1)
        total += len(data)
        if total > skills.MAX_BYTES:
            raise HTTPException(413, "技能包不能超过 20 MB")
        values.append((file.filename or "", data))
    return skills.preview(values)


@router.post("/skills/import", response_model=skills.SkillRead)
def skill_import(value: skills.ImportConfirm):
    return skills.import_skill(value)


@router.patch("/skills/{skill_id}", response_model=skills.SkillRead)
async def skill_update(skill_id: str, value: skills.SkillUpdate):
    with Session() as db:
        row = skills.require(db, skill_id)
        for name, item in value.model_dump(exclude_none=True).items():
            setattr(row, name, item)
        if not row.enabled or not row.scripts_allowed:
            skills.stop(skill_id)
        db.commit()
        return row


@router.delete("/skills/{skill_id}")
def skill_delete(skill_id: str):
    import shutil

    with Session() as db:
        row = skills.require(db, skill_id)
        if skills.active.get(skill_id):
            raise HTTPException(409, "请先停止技能，再删除")
        db.delete(row)
        db.commit()
        shutil.rmtree(skills.root() / skill_id, ignore_errors=True)
    return {"deleted": True}


@router.post("/skills/{skill_id}/stop")
async def skill_stop(skill_id: str):
    with Session() as db:
        skills.require(db, skill_id)
    skills.stop(skill_id)
    return {"stopping": True}


@router.get("/skill-runtimes")
def skill_runtimes():
    return skills.runtime_info()


@router.put("/skill-runtimes")
def set_runtimes(value: dict[str, str]):
    from pathlib import Path

    if any(
        key not in skills.RUNTIMES
        or (path and (not Path(path).is_absolute() or not Path(path).is_file()))
        for key, path in value.items()
    ):
        raise HTTPException(422, "解释器必须是现有程序的绝对路径；留空使用自动检测")
    with Session() as db:
        for name, path in value.items():
            db.merge(SkillRuntime(name=name, path=path))
        db.commit()
    return skills.runtime_info()


class ArtifactRead(BaseModel):
    id: str
    name: str
    media_type: str
    source_url: str
    image: bool


class SourceRead(BaseModel):
    title: str
    url: str
    summary: str
    kind: str


class PresentationRead(BaseModel):
    artifacts: list[ArtifactRead]
    sources: list[SourceRead]
    errors: list[str]
    image_urls: list[str] = Field(default_factory=list)


@router.get("/runs/{run_id}/presentation", response_model=PresentationRead)
def presentation(run_id: str):
    with Session() as db:
        if db.get(Run, run_id) is None:
            raise HTTPException(404, "执行记录不存在")
    return artifacts.presentation(run_id)


class ImageResolve(BaseModel):
    url: str = Field(min_length=1, max_length=16000)


@router.post("/runs/{run_id}/images", response_model=ArtifactRead)
async def resolve_image(run_id: str, value: ImageResolve):
    with Session() as db:
        if db.get(Run, run_id) is None:
            raise HTTPException(404, "执行记录不存在")
        from . import restricted_files
        if restricted_files.restricted(db.get(Run, run_id).conversation_id):
            raise HTTPException(403, "受限文件任务不加载外部图片")
    try:
        return await artifacts.image_from_url(run_id, value.url)
    except (ValueError, OSError, httpx.HTTPError):
        raise HTTPException(
            422, "图片加载失败，请检查图片地址或稍后重试；未重新调用生成工具"
        )


@router.get("/artifacts/{artifact_id}/content")
def artifact_content(artifact_id: str, download: bool = False):
    path, record = artifacts.file_record(artifact_id)
    # Non-image files always download; imported HTML/JS must never run in the app origin.
    return FileResponse(
        path,
        media_type=record.media_type,
        filename=record.name
        if download or not record.media_type.startswith("image/")
        else None,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.get("/artifacts/{artifact_id}/preview")
async def artifact_preview(artifact_id: str, page: int = 1):
    try:
        return await office.preview_artifact(artifact_id,page)
    except ValueError as error:
        raise HTTPException(422,str(error)) from None


@router.post("/artifacts/{artifact_id}/export")
def artifact_export(artifact_id: str):
    import re
    import shutil
    from pathlib import Path

    from . import config

    path, record = artifacts.file_record(artifact_id)
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", record.name).strip(" .") or "文件"
    if len(safe_name) > 100:
        safe_name = safe_name[:85] + Path(safe_name).suffix[:12]
    folder = config.DATA_DIR / "exports"
    folder.mkdir(exist_ok=True)
    # Keep the user-facing name clean: never prefix exported files with the artifact id.
    target = folder / safe_name
    if target.exists():
        stem, suffix = Path(safe_name).stem, Path(safe_name).suffix
        for index in range(2, 1000):
            candidate = folder / f"{stem} ({index}){suffix}"
            if not candidate.exists():
                target = candidate
                break
        else:
            raise HTTPException(409, "导出目录中的同名文件过多，请先整理后再试。")
    shutil.copyfile(path, target)
    return {"name": target.name, "path": str(target)}
