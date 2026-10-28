"""Saved, read-only learning handoffs from personal-assistant conversations."""
import re
from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from .config import PROFILE_ID
from .db import Conversation, Message, Run, RunEvent, Session, now
from .learning_sessions import list_continuations
from .runs import emit

router = APIRouter()


def continuation_requested(text):
    return (len(text) <= 160 and bool(re.search(r"继续学习|接着学|继续学|上次学到哪|昨天学到哪", text))
            and not re.search(r"(?:不要|不想|不用|停止|结束|取消).{0,6}(?:继续|学习|学)|(?:怎么实现|如何实现).{0,12}(?:功能|接续)|(?:帮我|请你|请).{0,8}(?:总结|整理|生成|修改|解释|分析|制定|创建|建立)|新的?学习|重新.{0,8}(?:安排|计划|课程)", text))


def continuation_candidates(text, values):
    named = [value for value in values if value["goal_title"] and value["goal_title"] in text]
    if named:
        return named
    topic = re.sub(r"^(?:请|帮我|我想)?(?:继续学习|继续学|接着学)", "", text.strip()).strip(" 。！!，,吧")
    if topic and topic not in {"上次的内容", "之前的课程", "昨天的内容", "一下", "上次学到哪", "昨天学到哪"}:
        return [value for value in values if topic.casefold() in value["goal_title"].casefold()]
    return [value for value in values if value.get("goal_status") != "completed"]


async def handle(run_id, conversation_id, text):
    # Match the intent clause; words inside a goal name (e.g. 数据分析) are not commands.
    compact = text.strip()
    if not continuation_requested(compact):
        return None
    values = list_continuations()
    candidates = continuation_candidates(text, values)
    if values and not candidates:
        return None
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
