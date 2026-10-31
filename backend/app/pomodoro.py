"""Local focus clock. Reads never invoke a model; only explicit actions start phases."""
from datetime import UTC, datetime, time, timedelta
from threading import RLock
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, func, select

from . import db as store
from .config import PROFILE_ID

router = APIRouter()
lock = RLock()
desktop_boot_id: str | None = None


class PomodoroPreset(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=40)
    focus_minutes: int = Field(ge=1, le=180)
    break_minutes: int = Field(ge=1, le=60)


BUILTINS = [PomodoroPreset(id=f"builtin-{f}-{b}", focus_minutes=f, break_minutes=b)
            for f, b in ((10, 3), (25, 5), (45, 5), (50, 10))]


class PomodoroPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presets: list[PomodoroPreset] = Field(min_length=4, max_length=24)
    selected_preset: str
    sound_enabled: bool
    sound_volume: int = Field(default=100, ge=0, le=100)

    @model_validator(mode="after")
    def valid_presets(self):
        values = {p.id: p for p in self.presets}
        if len(values) != len(self.presets) or self.selected_preset not in values:
            raise ValueError("请选择有效预设，预设编号不能重复")
        if any(values.get(p.id) != p for p in BUILTINS):
            raise ValueError("请保留四个内置预设的原始时长")
        builtin_ids = {p.id for p in BUILTINS}
        if any(key.startswith("builtin-") and key not in builtin_ids for key in values):
            raise ValueError("自定义预设不能使用内置预设编号")
        return self


class PomodoroSettingsWrite(PomodoroPreferences):
    expected_revision: int = Field(ge=0)


class PomodoroAction(BaseModel):
    action: Literal["start_focus", "start_break", "pause", "resume", "end", "skip_break", "pause_exit"]
    expected_revision: int | None = Field(default=None, ge=0)


class PomodoroSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    focus_minutes: int
    break_minutes: int


class PomodoroStatistics(BaseModel):
    today_seconds: float
    week_seconds: float
    total_seconds: float
    completed_rounds: int


class PomodoroRead(BaseModel):
    revision: int
    server_now: float
    phase: Literal["idle", "focus", "waiting_break", "break", "waiting_focus"]
    status: Literal["idle", "running", "paused", "waiting"]
    remaining_seconds: float
    deadline_at: float | None
    session: PomodoroSessionRead | None
    preferences: PomodoroPreferences
    statistics: PomodoroStatistics
    notification_seq: int
    notification_kind: Literal["focus_complete", "break_complete"] | None


def state_for(db):
    state = db.get(store.PomodoroState, PROFILE_ID)
    if state is None:
        state = store.PomodoroState(profile_id=PROFILE_ID, preferences=PomodoroPreferences(
            presets=list(BUILTINS), selected_preset="builtin-25-5", sound_enabled=True).model_dump())
        db.add(state)
        db.flush()
    return state


def selected(state):
    preferences = PomodoroPreferences.model_validate(state.preferences)
    return next(p for p in preferences.presets if p.id == preferences.selected_preset)


def advance(db, state, current):
    if state.status != "running":
        return
    checkpoint = state.checkpoint_at if state.checkpoint_at is not None else current
    elapsed = min(state.remaining_seconds, max(0, current - checkpoint))
    endpoint = checkpoint + elapsed
    if state.segment_id:
        segment = db.get(store.PomodoroSegment, state.segment_id)
        if segment:
            segment.ended_at = max(segment.ended_at, endpoint)
    state.remaining_seconds = max(0, state.remaining_seconds - elapsed)
    state.checkpoint_at = current
    state.deadline_at = current + state.remaining_seconds
    if state.remaining_seconds > 0:
        return
    session = db.get(store.PomodoroSession, state.session_id)
    if state.phase == "focus":
        session.completed_at = endpoint
        state.phase = "waiting_break"
        state.remaining_seconds = session.break_minutes * 60
        state.notification_kind = "focus_complete"
    else:
        session.ended_at = endpoint
        state.phase = "waiting_focus"
        state.remaining_seconds = selected(state).focus_minutes * 60
        state.notification_kind = "break_complete"
    state.status = "waiting"
    state.checkpoint_at = state.deadline_at = state.segment_id = None
    state.notification_seq += 1
    state.revision += 1


def start_segment(db, state, current):
    state.status = "running"
    state.checkpoint_at = current
    state.deadline_at = current + state.remaining_seconds
    if state.phase == "focus":
        segment = store.PomodoroSegment(session_id=state.session_id, started_at=current, ended_at=current)
        db.add(segment)
        db.flush()
        state.segment_id = segment.id


def pause(state):
    if state.status == "running":
        state.status = "paused"
        state.checkpoint_at = state.deadline_at = state.segment_id = None
        state.revision += 1


def recover():
    # Persisted segment ends are the last confirmed checkpoint, never the restart time.
    with lock, store.Session() as db:
        state = state_for(db)
        if state.session_id:
            session = db.get(store.PomodoroSession, state.session_id)
            if session and session.ended_at is None:
                confirmed = db.scalar(select(func.max(store.PomodoroSegment.ended_at)).where(
                    store.PomodoroSegment.session_id == session.id))
                session.ended_at = state.checkpoint_at or session.completed_at or confirmed or datetime.fromisoformat(session.created_at).timestamp()
        state.session_id = None
        state.phase = state.status = "idle"
        state.remaining_seconds = selected(state).focus_minutes * 60
        state.checkpoint_at = state.deadline_at = state.segment_id = None
        state.notification_kind = None
        state.revision += 1
        db.commit()


def shutdown():
    with lock, store.Session() as db:
        state = state_for(db)
        advance(db, state, datetime.now(UTC).timestamp())
        pause(state)
        db.commit()


def tick():
    with lock, store.Session() as db:
        state = state_for(db)
        advance(db, state, datetime.now(UTC).timestamp())
        db.commit()


def statistics(db, current):
    settings = db.get(store.Settings, PROFILE_ID)
    try:
        zone = ZoneInfo(settings.timezone if settings else "Asia/Shanghai")
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("Asia/Shanghai")
    local = datetime.fromtimestamp(current, zone)
    today = datetime.combine(local.date(), time.min, zone).timestamp()
    week = datetime.combine(local.date() - timedelta(days=local.weekday()), time.min, zone).timestamp()
    segment = store.PomodoroSegment
    duration = segment.ended_at - segment.started_at
    def since(boundary):
        return case((segment.ended_at > boundary, segment.ended_at - case(
            (segment.started_at > boundary, segment.started_at), else_=boundary)), else_=0)
    total, daily, weekly = db.execute(select(func.coalesce(func.sum(duration), 0),
        func.coalesce(func.sum(since(today)), 0), func.coalesce(func.sum(since(week)), 0))
        .where(segment.profile_id == PROFILE_ID)).one()
    completed = db.scalar(select(func.count()).select_from(store.PomodoroSession).where(
        store.PomodoroSession.profile_id == PROFILE_ID, store.PomodoroSession.completed_at.is_not(None)))
    return PomodoroStatistics(today_seconds=max(0, daily), week_seconds=max(0, weekly),
                              total_seconds=max(0, total), completed_rounds=completed)


def snapshot(db, state, current):
    db.flush()
    session = db.get(store.PomodoroSession, state.session_id) if state.session_id else None
    remaining = selected(state).focus_minutes * 60 if state.phase in ("idle", "waiting_focus") else state.remaining_seconds
    return PomodoroRead(revision=state.revision, server_now=current, phase=state.phase,
        status=state.status, remaining_seconds=remaining, deadline_at=state.deadline_at,
        session=PomodoroSessionRead.model_validate(session) if session else None,
        preferences=PomodoroPreferences.model_validate(state.preferences), statistics=statistics(db, current),
        notification_seq=state.notification_seq, notification_kind=state.notification_kind)


class DesktopRestart(BaseModel):
    boot_id: str = Field(pattern=r"^[a-f0-9-]{36}$")


@router.post("/pomodoro/restart", response_model=PomodoroRead)
def restart(value: DesktopRestart):
    global desktop_boot_id
    with lock:
        if desktop_boot_id != value.boot_id:
            recover()
            desktop_boot_id = value.boot_id
        return read()


@router.get("/pomodoro", response_model=PomodoroRead)
def read():
    with lock, store.Session() as db:
        current = datetime.now(UTC).timestamp()
        state = state_for(db)
        advance(db, state, current)
        value = snapshot(db, state, current)
        db.commit()
        return value


def check_revision(state, expected):
    if expected != state.revision:
        raise HTTPException(409, "番茄钟状态已变化，请按当前状态重试。")


@router.patch("/pomodoro/settings", response_model=PomodoroRead)
def settings(value: PomodoroSettingsWrite):
    with lock, store.Session() as db:
        current = datetime.now(UTC).timestamp()
        state = state_for(db)
        advance(db, state, current)
        # Retain a completion reached before an outdated request, including its reminder.
        db.commit()
        check_revision(state, value.expected_revision)
        state.preferences = value.model_dump(exclude={"expected_revision"})
        state.revision += 1
        result = snapshot(db, state, current)
        db.commit()
        return result


@router.post("/pomodoro/actions", response_model=PomodoroRead)
def action(value: PomodoroAction):
    with lock, store.Session() as db:
        current = datetime.now(UTC).timestamp()
        state = state_for(db)
        advance(db, state, current)
        db.commit()
        if value.action != "pause_exit":
            check_revision(state, value.expected_revision)
        command = value.action
        if command == "pause_exit":
            pause(state)
        elif command == "start_focus" and state.phase in ("idle", "waiting_focus"):
            previous = db.get(store.PomodoroSession, state.session_id) if state.session_id else None
            if previous and previous.ended_at is None:
                previous.ended_at = current
            preset = selected(state)
            session = store.PomodoroSession(focus_minutes=preset.focus_minutes,
                                            break_minutes=preset.break_minutes)
            db.add(session)
            db.flush()
            state.session_id = session.id
            state.phase = "focus"
            state.remaining_seconds = preset.focus_minutes * 60
            start_segment(db, state, current)
            state.revision += 1
        elif command == "start_break" and state.phase == "waiting_break":
            state.phase = "break"
            start_segment(db, state, current)
            state.revision += 1
        elif command == "pause" and state.status == "running":
            pause(state)
        elif command == "resume" and state.status == "paused":
            start_segment(db, state, current)
            state.revision += 1
        elif command == "skip_break" and state.phase in ("waiting_break", "break"):
            state.phase, state.status = "waiting_focus", "waiting"
            state.checkpoint_at = state.deadline_at = state.segment_id = None
            state.remaining_seconds = selected(state).focus_minutes * 60
            state.revision += 1
        elif command == "end" and state.phase != "idle":
            session = db.get(store.PomodoroSession, state.session_id)
            if session and session.ended_at is None:
                session.ended_at = current
            state.session_id = None
            state.phase = state.status = "idle"
            state.checkpoint_at = state.deadline_at = state.segment_id = None
            state.revision += 1
        else:
            raise HTTPException(409, "当前阶段不能执行此操作，请刷新后重试。")
        result = snapshot(db, state, current)
        db.commit()
        return result
