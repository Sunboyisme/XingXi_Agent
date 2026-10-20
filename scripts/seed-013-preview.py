"""Clearly labelled local examples for the isolated desktop preview, never personal data."""

import io
import os
import sys
from pathlib import Path

project = Path(__file__).resolve().parents[1]
target = Path(os.environ["BAI_DATA_DIR"]).resolve()
if target != project / ".local-data" / "preview-0.1.3":
    raise SystemExit("Only the retired mock QA directory may be seeded; never preview-runtime")
sys.path.insert(0, str(project / "backend"))

from app import artifacts, db, skills
from PIL import Image
from sqlalchemy import select

title = "0.1.3 · 本地模拟图文"
with db.Session() as session:
    conversation = session.scalar(
        select(db.Conversation).where(db.Conversation.title == title)
    )
    if conversation is None:
        conversation = db.Conversation(title=title)
        session.add(conversation)
        session.flush()
        run = db.Run(kind="chat", status="completed", conversation_id=conversation.id)
        session.add(run)
        session.flush()
        session.add(
            db.Message(
                conversation_id=conversation.id,
                role="user",
                content="本地模拟：查看图片、网页来源和文件产物的展示。",
            )
        )
        session.add(
            db.Message(
                conversation_id=conversation.id,
                role="assistant",
                run_id=run.id,
                content="这是一条明确标注的本地模拟记录，用来检查图片和来源展示。没有调用真实模型、生图服务或微信。下方色块是测试图片，网页链接是示例来源。",
            )
        )
        session.commit()
        image = io.BytesIO()
        Image.new("RGB", (480, 270), (198, 145, 116)).save(image, format="PNG")
        picture = artifacts.save_file(
            run.id, "本地模拟图片.png", image.getvalue(), image=True
        )
        note = artifacts.save_file(
            run.id,
            "本地模拟笔记.md",
            "# 本地模拟\n\n这是桌面文件保存验收用的示例，不是真实模型产物。\n".encode(),
        )
        session.add(
            db.RunEvent(
                run_id=run.id,
                kind="tool",
                data={
                    "name": "本地模拟结果",
                    "source": "fixture",
                    "status": "completed",
                    "result": {
                        "artifacts": [picture, note],
                        "sources": [
                            {
                                "title": "示例网页（本地模拟）",
                                "url": "https://example.com/013",
                                "summary": "用于验收网页来源展示，不代表已搜索或读取此网页。",
                                "kind": "search",
                            }
                        ],
                    },
                },
            )
        )
        session.commit()

with db.Session() as session:
    exists = session.scalar(select(db.Skill).where(db.Skill.name == "text-notes"))
if not exists:
    folder = project / "docs/examples/text-notes"
    files = [
        (file.relative_to(folder).as_posix(), file.read_bytes())
        for file in folder.rglob("*")
        if file.is_file()
    ]
    preview = skills.preview(files)
    skills.import_skill(skills.ImportConfirm(preview_id=preview["preview_id"]))
print("Isolated preview examples ready; skill and script permission remain disabled.")
