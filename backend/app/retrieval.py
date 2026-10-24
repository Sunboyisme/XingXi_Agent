"""Hybrid retrieval with a local, revision-checked semantic index."""

import asyncio
import hashlib
import json
import math
import re
import time

from langchain_openai import OpenAIEmbeddings
from sqlalchemy import select

from . import config
from .context import MEMORY_TOKENS, tokens
from .db import Memory, MemoryVector, Session, Settings

last_error = ""
indexing = False
MIN_SIMILARITY = 0.35


def settings():
    with Session() as db:
        return dict(db.get(Settings, config.PROFILE_ID).embedding_config or {})


def signature(value):
    return hashlib.sha256(
        json.dumps([value.get("url", "").rstrip("/"), value.get("model", "")]).encode()
    ).hexdigest()


def content_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


def valid(row, memory, value):
    return bool(
        row
        and row.signature == signature(value)
        and row.revision == memory.revision
        and row.content_hash == content_hash(memory.content)
        and memory.state == "confirmed"
    )


def client(value, *, purpose="embedding"):
    from .usage_cost import MeteredAsyncClient, metadata
    return OpenAIEmbeddings(
        base_url=value["url"],
        model=value["model"],
        api_key=config.secret_get("embedding"),
        check_embedding_ctx_length=False,
        max_retries=0,
        request_timeout=10,
        chunk_size=32,
        http_async_client=MeteredAsyncClient(
            usage_metadata=metadata(value, kind="embedding", purpose=purpose), timeout=10),
    )


def checked(vector):
    if (
        not vector
        or len(vector) > 65536
        or any(not math.isfinite(x) for x in vector)
        or not any(vector)
    ):
        raise ValueError("无效的向量")
    return vector


def terms(text):
    text = text.casefold()
    result = re.findall(r"[a-z0-9_]+", text)
    for part in re.findall(r"[\u3400-\u9fff]+", text):
        result.extend(part[i : i + 2] for i in range(max(1, len(part) - 1)))
    return set(result)


def keyword_score(query, text):
    keys, words = terms(query), terms(text)
    score = len(keys & words) / math.sqrt(max(1, len(keys) * len(words)))
    short_topics = re.findall(r"[\u3400-\u9fff]{1,2}(?![\u3400-\u9fff])", query)
    topic_chars = set("".join(short_topics)) - set("的一是在了有我你他她它个只要想学会吗呢吧好不无从到多少什么")
    overlap = sum(char in text for char in topic_chars)
    return score + (0.08 * overlap / max(1, len(topic_chars)))


def cosine(a, b):
    if len(a) != len(b):
        raise ValueError("向量维度不匹配")
    return sum(x * y for x, y in zip(a, b)) / (
        math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    )


def status():
    value = settings()
    with Session() as db:
        memories = list(
            db.scalars(
                select(Memory).where(
                    Memory.profile_id == config.PROFILE_ID, Memory.state == "confirmed"
                )
            )
        )
        vectors = {r.memory_id: r for r in db.scalars(select(MemoryVector))}
    return {
        "enabled": value.get("enabled", False),
        "url": value.get("url", "https://api.openai.com/v1"),
        "model": value.get("model", ""),
        "key_configured": bool(config.secret_get("embedding")),
        "indexed": sum(valid(vectors.get(m.id), m, value) for m in memories),
        "total": len(memories),
        "indexing": indexing,
        "error": last_error,
    }


async def index_once():
    global indexing, last_error
    value = settings()
    if not value.get("enabled") or not config.secret_get("embedding"):
        return
    with Session() as db:
        memories = list(
            db.scalars(
                select(Memory).where(
                    Memory.profile_id == config.PROFILE_ID, Memory.state == "confirmed"
                )
            )
        )
        vectors = {r.memory_id: r for r in db.scalars(select(MemoryVector))}
        active = {m.id for m in memories}
        for key, row in vectors.items():
            if key not in active:
                db.delete(row)
        pending = [
            (m.id, m.revision, m.content)
            for m in memories
            if not valid(vectors.get(m.id), m, value)
        ][:32]
        db.commit()
    if not pending:
        return
    indexing = True
    try:
        result = await client(value).aembed_documents([x[2] for x in pending])
        if len(result) != len(pending) or len({len(v) for v in result}) != 1:
            raise ValueError("向量批次格式无效")
        for vector in result:
            checked(vector)
        with Session() as db:
            current = db.get(Settings, config.PROFILE_ID).embedding_config or {}
            if not current.get("enabled") or signature(current) != signature(value):
                return
            for (key, revision, content), vector in zip(pending, result):
                record = db.get(Memory, key)
                if (
                    not record
                    or record.state != "confirmed"
                    or record.revision != revision
                    or record.content != content
                ):
                    continue
                db.merge(
                    MemoryVector(
                        memory_id=key,
                        revision=revision,
                        content_hash=content_hash(content),
                        signature=signature(value),
                        vector=vector,
                    )
                )
            db.commit()
        last_error = ""
    except asyncio.CancelledError:
        raise
    except Exception:
        last_error = "语义索引暂不可用，已使用关键词检索。"
    finally:
        indexing = False


async def worker():
    global last_error
    while True:
        try:
            await index_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            last_error = "语义索引暂不可用，已使用关键词检索。"
        await asyncio.sleep(15 if last_error else 3)


async def retrieve_detailed(query: str, purpose="preview", project_id=None):
    global last_error
    started = time.monotonic()
    value = settings()
    with Session() as db:
        memories = list(
            db.scalars(
                select(Memory).where(
                    Memory.profile_id == config.PROFILE_ID, Memory.state == "confirmed",
                    ((Memory.project_id == project_id) | (Memory.project_id.is_(None) & (Memory.category.in_(["preference", "fact"])))) if project_id else Memory.project_id.is_(None),
                )
            )
        )
        vectors = {r.memory_id: r for r in db.scalars(select(MemoryVector))}
    originals = {m.id: m for m in memories}
    lexical = sorted(
        ((keyword_score(query, m.content), m.id) for m in memories), reverse=True
    )
    keyword_scores = {key: score for score, key in lexical}
    lists = [[key for score, key in lexical if score > 0][:20]]
    eligible = [m for m in memories if valid(vectors.get(m.id), m, value)]
    semantic_scores = {}
    mode = "keyword"
    if not value.get("enabled"):
        fallback = "语义检索未启用"
    elif not config.secret_get("embedding"):
        fallback = "Embedding 密钥未配置"
    elif not eligible:
        fallback = "暂无可用向量，等待索引更新"
    else:
        fallback = ""
        try:
            vector = checked(await client(value).aembed_query(query))
            semantic = sorted(
                (
                    (cosine(vector, checked(vectors[m.id].vector)), m.id)
                    for m in eligible
                ),
                reverse=True,
            )
            semantic_scores = {key: score for score, key in semantic[:20]}
            lists.append(
                [key for score, key in semantic if score >= MIN_SIMILARITY][:20]
            )
            mode = "hybrid"
            last_error = ""
        except asyncio.CancelledError:
            raise
        except Exception:
            last_error = fallback = "语义查询暂不可用，已使用关键词检索。"
    scores = {}
    for ranked in lists:
        for i, key in enumerate(ranked):
            scores[key] = scores.get(key, 0) + 1 / (61 + i)
    result, budget = [], MEMORY_TOKENS
    reasons = {}
    # Validate again after network I/O, including manually edited records and configuration.
    with Session() as db:
        current_config = db.get(Settings, config.PROFILE_ID).embedding_config or {}
        if signature(current_config) != signature(value) or current_config.get(
            "enabled"
        ) != value.get("enabled"):
            scores = {key: 1 / (61 + i) for i, key in enumerate(lists[0])}
            mode, fallback = "keyword", "检索期间配置已变更，已使用关键词结果"
        for key in sorted(scores, key=lambda key: (-scores[key], key)):
            record = db.get(Memory, key)
            original = originals[key]
            if (
                not record
                or record.profile_id != config.PROFILE_ID
                or record.state != "confirmed"
                or record.revision != original.revision
                or record.content != original.content
                or record.project_id != original.project_id
            ):
                reasons[key] = "记忆已变更或删除"
                continue
            if len(result) == 5:
                reasons[key] = "超过5条上限"
                continue
            cost = tokens(record.content) + tokens(record.source) + 40
            if cost > budget:
                reasons[key] = "超过上下文预算"
                continue
            result.append(
                {"id": key, "content": record.content, "source": record.source}
            )
            budget -= cost
            reasons[key] = "已进入上下文" if purpose == "context" else "已选中"
    selected = [r["id"] for r in result]
    diagnostic_ids = set(lists[0]) | set(semantic_scores)
    candidates = [
        {
            "id": key,
            "content": originals[key].content,
            "source": originals[key].source,
            "revision": originals[key].revision,
            "keyword_score": keyword_scores.get(key, 0),
            "semantic_score": semantic_scores.get(key),
            "fusion_score": scores.get(key, 0),
            "selected": key in selected,
            "reason": reasons.get(key, "未达到语义阈值"),
        }
        for key in sorted(diagnostic_ids, key=lambda key: (-scores.get(key, 0), key))
    ]
    trace = {
        "query": query,
        "purpose": purpose,
        "mode": mode,
        "fallback_reason": fallback,
        "indexed": len(eligible),
        "total": len(memories),
        "threshold": MIN_SIMILARITY,
        "token_budget": MEMORY_TOKENS,
        "tokens_used": MEMORY_TOKENS - budget,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "selected_ids": selected,
        "candidates": candidates,
    }
    return result, trace


async def retrieve(query: str, run_id=None, purpose="context"):
    if not query.strip():
        return []
    from .db import Run, Conversation
    with Session() as db:
        run = db.get(Run, run_id) if run_id else None
        conversation = db.get(Conversation, run.conversation_id) if run and run.conversation_id else None
        project_id = conversation.project_id if conversation else None
    result, trace = await retrieve_detailed(query, purpose, project_id=project_id)
    if run_id:
        from .runs import emit

        emit(run_id, "retrieval", trace)
    return result
