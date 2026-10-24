"""Saved, read-only learning handoffs from personal-assistant conversations."""
import re
from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from .config import PROFILE_ID
from .db import Conversation, Message, Run, RunEvent, Session, now
from .learning_sessions import list_continuations
from .runs import emit

router = APIRouter()


async def handle(run_id, conversation_id, text):
    if len(text) > 160 or not re.search(r"继续学习|接着学|继续学|上次学到哪|昨天学到哪", text) or re.search(r"不要|不想|不用|停止|结束|取消|怎么实现|功能|总结|整理|生成|修改|解释|分析", text):
        return None
    values = list_continuations()
    named = [value for value in values if value["goal_title"] and value["goal_title"] in text]
    candidates = named or [value for value in values if value.get("goal_status") != "completed"]
    if not candidates:
        content = "还没有可接续的学习目标。可以在学习界面创建目标，再开始学习。"
    elif len(candidates) == 1:
        content = "找到了上次的学习记录，点击下面的接续卡回到学习界面。"
    else:
        content = "你有几个学习目标，选择这次想继续的一个。"
    emit(run_id, "learning_continuation", {"cards": candidates})
    with Session() as db:
        db.add(Message(conversation_id=conversation_id, role="assistant", run_id=run_id, content=content))
        db.get(Conversation, conversation_id).updated_at = now()
        db.commit()
    emit(run_id, "answer", {"text": content})
    return {"content": content, "conversation_id": conversation_id}


@router.get("/runs/{run_id}/learning-continuations")
def cards(run_id: str):
    with Session() as db:
        run = db.get(Run, run_id)
        if not run or run.profile_id != PROFILE_ID:
            raise HTTPException(404, "运行记录不存在")
        values = list(db.scalars(select(RunEvent).where(RunEvent.run_id == run_id,
            RunEvent.kind == "learning_continuation").order_by(RunEvent.id.desc())))
        return values[0].data.get("cards", []) if values else []
