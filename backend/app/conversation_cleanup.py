"""Delete chat-owned records; keep saved memories, courses and plans."""

import re
import shutil

from sqlalchemy import delete, select

from . import config
from .db import Attachment, Artifact, Attempt, CalendarBatch, ComplexTask, Message, OfficeFile, PlanCreation, ProjectMaterial, Run, WechatDelivery, WechatInbox


def remove(db, conversation):
    message_ids, attachment_ids = [], set()
    for message in db.scalars(select(Message).where(Message.conversation_id == conversation.id)):
        message_ids.append(message.id)
        attachment_ids.update(message.attachment_ids)
    attachment_ids.update(db.scalars(select(OfficeFile.id).where(OfficeFile.conversation_id == conversation.id)))
    run_ids = list(db.scalars(select(Run.id).where(Run.conversation_id == conversation.id)))
    task_ids = list(db.scalars(select(ComplexTask.id).where(ComplexTask.conversation_id == conversation.id)))
    inbox_ids = list(db.scalars(select(WechatInbox.id).where(WechatInbox.run_id.in_(run_ids))))
    db.execute(delete(WechatDelivery).where(WechatDelivery.source_key.in_(["chat:" + key for key in inbox_ids])))
    outputs = list(db.scalars(select(Artifact.storage_name).where(Artifact.run_id.in_(run_ids))))
    db.execute(delete(CalendarBatch).where(CalendarBatch.source_message_id.in_(message_ids)))
    db.execute(delete(PlanCreation).where(PlanCreation.source_message_id.in_(message_ids)))
    # Run has no conversation FK; explicitly delete it so its event/artifact FKs cascade.
    db.execute(delete(Run).where(Run.id.in_(run_ids)))
    db.delete(conversation)
    db.flush()
    referenced = set()
    referenced.update(db.scalars(select(ProjectMaterial.file_id)))
    for ids in db.scalars(select(Message.attachment_ids)):
        referenced.update(ids)
    for ids in db.scalars(select(Attempt.attachment_ids)):
        referenced.update(ids)
    from .learning_sessions import draft_attachment_ids
    referenced.update(draft_attachment_ids(db))
    attachment_ids.difference_update(referenced)
    db.execute(delete(Attachment).where(Attachment.id.in_(attachment_ids)))
    db.commit()
    # Only unlink managed filenames, after the database transaction succeeds.
    paths = []
    for key in attachment_ids:
        if re.fullmatch(r"[a-f0-9-]{36}", key):
            paths.extend([config.ATTACHMENTS_DIR / f"{key}.jpg", config.ATTACHMENTS_DIR / "files" / f"{key}.bin"])
    paths.extend(config.ATTACHMENTS_DIR / "artifacts" / name for name in outputs if re.fullmatch(r"[a-f0-9-]{36}\.bin", name))
    failures = 0
    for path in paths:
        if path.resolve().is_relative_to(config.ATTACHMENTS_DIR.resolve()):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                failures += 1
    work_root = (config.DATA_DIR / "skill-runs").resolve()
    if work_root.is_relative_to(config.DATA_DIR.resolve()):
        for key in set(run_ids + task_ids):
            if not re.fullmatch(r"[a-f0-9-]{36}", key):
                continue
            work = work_root / key
            if work.is_dir() and not work.is_symlink() and work.resolve().is_relative_to(work_root):
                try:
                    shutil.rmtree(work)
                except OSError:
                    failures += 1
    return {"deleted": True, "cleanup_pending": failures}
