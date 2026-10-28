"""Persist chat-created course receipts before awaiting course generation."""
import asyncio
import hashlib
import json

from sqlalchemy import or_, select

from . import learning, runs, task_context
from .config import PROFILE_ID
from .db import Goal, KnowledgeNode, Run, Session, now


def read(db, parent):
    result = []
    for saved in parent.result.get("learning_courses", []):
        goal = db.get(Goal, saved["goal_id"])
        planning = db.get(Run, saved.get("planning_run_id")) if saved.get("planning_run_id") else None
        nodes = list(db.scalars(select(KnowledgeNode).where(KnowledgeNode.goal_id == saved["goal_id"],
            KnowledgeNode.profile_id == PROFILE_ID).order_by(KnowledgeNode.ordinal))) if goal else []
        status = "completed" if nodes and (not planning or planning.status == "completed") else (
            "running" if planning and planning.status in {"queued", "running"} else "cancelled" if planning and planning.status == "cancelled" else "failed")
        result.append({**saved, "status": status,
            "nodes": [{"id": node.id, "title": node.title, "module": node.module, "objective": node.objective} for node in nodes],
            "overview": planning.result.get("overview", "") if planning else "",
            "error": (planning.error if planning else None) or ("本次课程生成已停止，可重试当前请求。" if status != "completed" and status != "running" else None)})
    return result


async def create(run_id, conversation_id, values):
    key = hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with Session() as db:
        parent = db.get(Run, run_id)
        source = task_context.user_message(db, run_id, conversation_id)
        related = list(db.scalars(select(Run).where(Run.conversation_id == conversation_id,
            Run.profile_id == PROFILE_ID,
            or_(Run.source_message_id == source.id, Run.task_id == parent.task_id) if parent.task_id else Run.source_message_id == source.id)))
        prior = next((item for record in related for item in record.result.get("learning_courses", [])
                      if item.get("request_key") == key and item.get("source_message_id") == source.id), None)
        goal = db.get(Goal, prior["goal_id"]) if prior else None
        if goal is None:
            goal = Goal(**values)
            db.add(goal)
            db.flush()
        nodes = list(db.scalars(select(KnowledgeNode).where(KnowledgeNode.goal_id == goal.id).order_by(KnowledgeNode.ordinal)))
        planning = db.get(Run, prior["planning_run_id"]) if prior else None
        launch = not nodes and (planning is None or planning.status not in {"queued", "running"})
        if launch:
            planning = Run(kind="course", goal_id=goal.id)
            db.add(planning)
            db.flush()
        receipt = {"request_key": key, "source_message_id": source.id, "goal_id": goal.id,
                   "planning_run_id": planning.id if planning else None,
                   "title": goal.title, "status": "completed" if nodes else "running", "nodes": []}
        parent.result = {**parent.result, "learning_courses": [
            *[item for item in parent.result.get("learning_courses", []) if item.get("request_key") != key], receipt]}
        db.commit()
        goal_id, planning_id = goal.id, planning.id if planning else None
    runs.emit(run_id, "learning_course", receipt)
    runs.emit(run_id, "progress", {"stage": "course", "message": "正在生成课程目录", "goal_id": goal_id})
    if launch:
        runs.launch(planning_id, lambda: learning.generate_course(goal_id, planning_id))
    try:
        if planning_id in runs.tasks:
            await runs.tasks[planning_id]
    finally:
        with Session() as db:
            parent = db.get(Run, run_id)
            if parent:
                receipt = next(item for item in read(db, parent) if item["request_key"] == key)
                receipt = {**receipt, "completed_at": now(), "next_action": "查看本次课程目录，再开始学习"}
                parent.result = {**parent.result, "learning_courses": [
                    *[item for item in parent.result.get("learning_courses", []) if item.get("request_key") != key], receipt]}
                db.commit()
                runs.emit(run_id, "learning_course", receipt)
    if asyncio.current_task().cancelling():
        raise asyncio.CancelledError()
    return receipt
