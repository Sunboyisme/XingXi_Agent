"""Observable request ledger. Never infer provider bills from text length."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
import logging
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from . import config, model_profiles
from .db import Run, Session, Settings, UsageCall, UsagePrice, now, uid

router = APIRouter()
context = ContextVar("usage_cost_context", default={})
log = logging.getLogger(__name__)
unsupported_stream_usage: set[tuple[str, str]] = set()


@contextmanager
def scope(*, run_id=None, purpose=None):
    value = dict(context.get())
    if run_id is not None:
        value["run_id"] = run_id
    if purpose is not None:
        value["purpose"] = purpose
    token = context.set(value)
    try:
        yield
    finally:
        context.reset(token)


def connection_key(kind, url):
    return kind + ":" + hashlib.sha256(url.rstrip("/").encode()).hexdigest()[:16]


def metadata(value, kind="tokens", purpose=None):
    provider_id = value.get("provider_id")
    label = value.get("provider_label", "")
    if not provider_id:
        service = "image_generation" if kind == "images" else "embedding"
        provider_id = connection_key(service, value.get("url", ""))
        label = "图片生成连接" if kind == "images" else "语义记忆连接"
    if not label:
        with Session() as db:
            settings = db.get(Settings, config.PROFILE_ID)
            profile = next((x for x in model_profiles.profiles(settings) if x["id"] == provider_id), None) if settings else None
        label = profile.get("label", provider_id) if profile else provider_id
    return {"provider_id": provider_id, "provider_label": label,
            "model_name": value.get("model_name", value.get("model", "")),
            "kind": kind, "purpose": purpose, "image_size": value.get("size", "")}


def snapshot(price):
    return {"id": price.id, "currency": price.currency, "kind": price.kind,
            "image_size": price.image_size, "rates": price.rates, "effective_at": price.created_at}


def start(meta, request_body):
    current = context.get()
    purpose = meta.get("purpose") or current.get("purpose", "connection_test")
    if purpose == "chat":
        from .task_context import current as task_current
        execution = task_current.get()
        if execution and execution.task_id:
            purpose = "complex_task"
    model_name = str(request_body.get("model") or meta["model_name"])[:200]
    image_size = str(request_body.get("size") or (request_body.get("parameters") or {}).get("size") or meta.get("image_size", "")).replace("*", "x")[:40]
    with Session() as db:
        prices = list(db.scalars(select(UsagePrice).where(
            UsagePrice.profile_id == config.PROFILE_ID,
            UsagePrice.provider_id == meta["provider_id"], UsagePrice.model_name == model_name,
        ).order_by(UsagePrice.created_at.desc())))
        eligible = [p for p in prices if (not p.image_size or p.image_size == image_size)
                    and (p.kind == meta["kind"] or meta["kind"] == "images" and p.kind == "tokens")]
        # A size-specific price wins over a wildcard, each has immutable versions.
        price = next((p for p in eligible if p.image_size == image_size and image_size), eligible[0] if eligible else None)
        row = UsageCall(id=uid(), run_id=current.get("run_id"),
            provider_id=meta["provider_id"], provider_label=meta["provider_label"],
            model_name=model_name, purpose=purpose,
            kind=meta["kind"], image_size=image_size,
            price_snapshot=snapshot(price) if price else {})
        db.add(row)
        db.commit()
        return row.id


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def usage_values(payload, kind):
    usage = payload.get("usage") if isinstance(payload, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    incoming = count(usage.get("input_tokens", usage.get("prompt_tokens")))
    outgoing = count(usage.get("output_tokens", usage.get("completion_tokens")))
    if kind == "embedding" and incoming is not None:
        outgoing = 0
    details = usage.get("prompt_tokens_details", usage.get("input_tokens_details", {})) or {}
    cached = count(details.get("cached_tokens", usage.get("prompt_cache_hit_tokens")))
    written = count(usage.get("cache_creation_input_tokens"))
    # Some services report non-cached prompt tokens plus hit tokens separately.
    if incoming is None and count(usage.get("prompt_cache_miss_tokens")) is not None and cached is not None:
        incoming = usage["prompt_cache_miss_tokens"] + cached
    total = count(usage.get("total_tokens"))
    if total is None and incoming is not None and outgoing is not None:
        total = incoming + outgoing
    images = None
    if kind == "images" and isinstance(payload, dict):
        rows = payload.get("data")
        if isinstance(rows, list):
            images = sum(isinstance(x, dict) and bool(x.get("url") or x.get("b64_json")) for x in rows) or None
        if images is None:
            output = payload.get("output") or {}
            choices = output.get("choices", []) if isinstance(output, dict) else []
            images = sum(bool(item.get("image")) for choice in choices if isinstance(choice, dict)
                for item in (choice.get("message") or {}).get("content", []) if isinstance(item, dict)) or None
    return {"input_tokens": incoming, "output_tokens": outgoing, "total_tokens": total,
            "cached_tokens": cached, "cache_write_tokens": written, "image_count": images}


def estimate(row):
    price = row.price_snapshot or {}
    if not price:
        return None, "未配置调用发生时的价格"
    rates = price["rates"]
    if price["kind"] == "images":
        if row.image_count is None:
            return None, "服务商未返回可确认的图片数量"
        return str(Decimal(str(rates["image"])) * row.image_count), ""
    if row.input_tokens is None or row.output_tokens is None:
        return None, "服务商未返回完整输入／输出用量"
    if "cached" in rates and row.cached_tokens is None:
        return None, "已配置缓存读取价格，但服务商未返回缓存读取用量"
    if "cache_write" in rates and row.cache_write_tokens is None:
        return None, "已配置缓存写入价格，但服务商未返回缓存写入用量"
    cached = row.cached_tokens or 0
    written = row.cache_write_tokens or 0
    if cached + written > row.input_tokens:
        return None, "缓存用量与输入用量不一致"
    # When no separate cache tariff is configured, the ordinary input tariff applies.
    amount = (Decimal(str(rates["input"])) * (row.input_tokens - cached - written)
        + Decimal(str(rates.get("cached", rates["input"]))) * cached
        + Decimal(str(rates.get("cache_write", rates["input"]))) * written
        + Decimal(str(rates.get("output", 0))) * row.output_tokens) / Decimal(1_000_000)
    return format(amount, "f"), ""


def finish(call_id, payload=None, status="completed"):
    if not call_id:
        return
    try:
        with Session() as db:
            row = db.get(UsageCall, call_id)
            if not row or row.finished_at:
                return
            for name, value in usage_values(payload, row.kind).items():
                setattr(row, name, value)
            row.status, row.finished_at = status, now()
            row.estimated_cost, row.unknown_reason = estimate(row)
            if status != "completed" and row.estimated_cost is None:
                row.unknown_reason = "请求未完整结束，实际扣费未知；" + row.unknown_reason
            db.commit()
    except Exception:
        # Cost accounting must never replace a successful model result with an error.
        log.exception("Could not finalize usage call %s", call_id)


def recover_interrupted():
    with Session() as db:
        for row in db.scalars(select(UsageCall).where(UsageCall.status == "started")):
            row.status, row.finished_at = "interrupted", now()
            row.unknown_reason = "应用已重启，服务商用量与实际扣费未知"
        db.commit()


class MeteredStream(httpx.AsyncByteStream):
    def __init__(self, source, call_id):
        self.source, self.call_id = source, call_id
        self.buffer, self.payload, self.complete = b"", None, False

    def observe(self, chunk):
        self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if line.startswith(b"data:"):
                try:
                    value = json.loads(line[5:].strip())
                    if isinstance(value, dict) and isinstance(value.get("usage"), dict):
                        self.payload = {"usage": value["usage"]}
                except (ValueError, UnicodeDecodeError):
                    pass
        if len(self.buffer) > 262144:
            self.buffer = b""

    async def __aiter__(self):
        try:
            async for chunk in self.source:
                self.observe(chunk)
                yield chunk
            if self.buffer:
                self.observe(b"\n")
            self.complete = True
        finally:
            finish(self.call_id, self.payload, "completed" if self.complete else "interrupted")

    async def aclose(self):
        try:
            await self.source.aclose()
        finally:
            finish(self.call_id, self.payload, "completed" if self.complete else "interrupted")


class MeteredImageStream(httpx.AsyncByteStream):
    """Let the image caller enforce its existing streaming response-size limit."""

    def __init__(self, source, call_id, status):
        self.source, self.call_id, self.status = source, call_id, status
        self.encoded, self.complete, self.payload = bytearray(), False, None

    async def __aiter__(self):
        try:
            async for chunk in self.source:
                if len(self.encoded) + len(chunk) <= 16 * 1024 * 1024:
                    self.encoded.extend(chunk)
                else:
                    self.encoded.clear()
                yield chunk
            self.complete = True
            try:
                self.payload = json.loads(self.encoded)
            except (ValueError, UnicodeDecodeError):
                pass
        finally:
            finish(self.call_id, self.payload, self.status if self.complete else "interrupted")

    async def aclose(self):
        try:
            await self.source.aclose()
        finally:
            finish(self.call_id, self.payload, self.status if self.complete else "interrupted")


class MeteredAsyncClient(httpx.AsyncClient):
    """SDK retries call send again: each observable HTTP request gets its own row."""

    def __init__(self, *, usage_metadata, **kwargs):
        super().__init__(**kwargs)
        self.usage_metadata = dict(usage_metadata)

    async def send(self, request, **kwargs):
        if request.method != "POST":
            return await super().send(request, **kwargs)
        try:
            body = json.loads(request.content)
        except (ValueError, UnicodeDecodeError, httpx.RequestNotRead):
            body = {}
        if not isinstance(body, dict):
            body = {}
        capability_key = (str(request.url), str(body.get("model", "")))
        if (body.get("stream_options") or {}).get("include_usage") and capability_key in unsupported_stream_usage:
            request, body = self.without_stream_usage(request, body)
        # Observe usage without changing response text or buffering streamed images.
        request.headers["Accept-Encoding"] = "identity"
        call_id = None
        try:
            call_id = start(self.usage_metadata, body if isinstance(body, dict) else {})
        except Exception:
            log.exception("Could not start model usage record")
        try:
            response = await super().send(request, **kwargs)
            if body.get("stream") and response.is_success:
                response.stream = MeteredStream(response.stream, call_id)
            elif self.usage_metadata["kind"] == "images" and kwargs.get("stream"):
                response.stream = MeteredImageStream(response.stream, call_id,
                    "completed" if response.is_success else "failed")
            else:
                await response.aread()
                try:
                    payload = response.json()
                except (ValueError, UnicodeDecodeError):
                    payload = None
                finish(call_id, payload, "completed" if response.is_success else "failed")
                # An explicit rejection of this optional parameter happened before
                # generation. Retry once without it; each request stays in the ledger.
                if response.status_code in {400, 422} and (body.get("stream_options") or {}).get("include_usage"):
                    rejection = json.dumps(payload, ensure_ascii=False).lower()
                    if any(key in rejection for key in ("stream_options", "include_usage")) and any(
                        word in rejection for word in ("unsupported", "not support", "unknown", "unrecognized", "unexpected", "not allowed", "不支持", "无法识别")
                    ):
                        unsupported_stream_usage.add(capability_key)
                        await response.aclose()
                        replacement, _ = self.without_stream_usage(request, body)
                        return await self.send(replacement, **kwargs)
            return response
        except BaseException:
            finish(call_id, status="interrupted")
            raise

    @staticmethod
    def without_stream_usage(request, body):
        body = dict(body)
        options = dict(body.get("stream_options") or {})
        options.pop("include_usage", None)
        if options:
            body["stream_options"] = options
        else:
            body.pop("stream_options", None)
        headers = dict(request.headers)
        headers.pop("content-length", None)
        return httpx.Request(request.method, request.url, headers=headers,
            content=json.dumps(body, ensure_ascii=False).encode(), extensions=dict(request.extensions)), body


class PriceWrite(BaseModel):
    provider_id: str = Field(min_length=1, max_length=200)
    provider_label: str = Field(default="", max_length=200)
    model_name: str = Field(min_length=1, max_length=200)
    kind: str = "tokens"
    currency: str = Field(default="CNY", min_length=3, max_length=3)
    image_size: str = Field(default="", max_length=40)
    rates: dict[str, str] = Field(default_factory=dict)

    @field_validator("image_size")
    @classmethod
    def normalized_size(cls, value):
        return value.strip().replace("*", "x")

    @field_validator("kind")
    @classmethod
    def known_kind(cls, value):
        if value not in {"tokens", "embedding", "images"}:
            raise ValueError("不支持的计价方式")
        return value

    @field_validator("currency")
    @classmethod
    def currency_code(cls, value):
        if not value.isascii() or not value.isalpha():
            raise ValueError("请使用三位币种代码")
        return value.upper()

    @field_validator("rates")
    @classmethod
    def valid_rates(cls, value):
        cleaned = {}
        for key, raw in value.items():
            if key not in {"input", "output", "cached", "cache_write", "image"}:
                raise ValueError("不支持的价格项目")
            try:
                amount = Decimal(raw)
                if not amount.is_finite() or amount < 0 or amount > Decimal("1000000000"):
                    raise InvalidOperation
            except (InvalidOperation, ValueError):
                raise ValueError("单价必须是有效的非负数") from None
            cleaned[key] = format(amount, "f")
        return cleaned


def price_read(row):
    return {"id": row.id, "provider_id": row.provider_id, "provider_label": row.provider_label,
            "model_name": row.model_name, "created_at": row.created_at,
            "kind": row.kind, "currency": row.currency, "image_size": row.image_size, "rates": row.rates}


@router.get("/usage/prices")
def prices():
    with Session() as db:
        return [price_read(p) for p in db.scalars(select(UsagePrice).where(
            UsagePrice.profile_id == config.PROFILE_ID).order_by(UsagePrice.created_at.desc()))]


@router.post("/usage/prices")
def save_price(value: PriceWrite):
    required = {"image"} if value.kind == "images" else {"input"} if value.kind == "embedding" else {"input", "output"}
    if not required.issubset(value.rates):
        raise HTTPException(422, "请填写该计价方式的必需单价")
    with Session() as db:
        row = UsagePrice(**value.model_dump())
        db.add(row)
        db.commit()
        return price_read(row)


@router.get("/usage/models")
def available_models():
    with Session() as db:
        settings = db.get(Settings, config.PROFILE_ID)
        result = [{"provider_id": p["id"], "provider_label": p["label"], "model_name": m["name"], "kind": "tokens"}
                  for p in model_profiles.profiles(settings) for m in p["models"]]
        for field, kind, label in (("embedding_config", "embedding", "语义记忆连接"),
                                   ("image_generation_config", "images", "图片生成连接")):
            item = getattr(settings, field) or {}
            if item.get("model"):
                result.append({"provider_id": connection_key("embedding" if kind == "embedding" else "image_generation", item.get("url", "")),
                    "provider_label": label, "model_name": item["model"], "kind": kind})
        seen = {(x["provider_id"], x["model_name"], x["kind"]) for x in result}
        for row in db.scalars(select(UsageCall).where(UsageCall.profile_id == config.PROFILE_ID)):
            key = (row.provider_id, row.model_name, row.kind)
            if key not in seen:
                result.append({"provider_id": row.provider_id, "provider_label": row.provider_label,
                    "model_name": row.model_name, "kind": row.kind})
                seen.add(key)
        return result


def read_call(row):
    names = ("id", "created_at", "finished_at", "run_id", "provider_id", "provider_label", "model_name",
             "purpose", "kind", "status", "input_tokens", "output_tokens", "total_tokens", "cached_tokens",
             "cache_write_tokens", "image_count", "image_size", "estimated_cost", "unknown_reason", "price_snapshot")
    return {key: getattr(row, key) for key in names}


@router.get("/usage")
def report(start_date: date | None = None, end_date: date | None = None,
           offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500)):
    with Session() as db:
        settings = db.get(Settings, config.PROFILE_ID)
        zone = ZoneInfo(settings.timezone or "Asia/Shanghai")
        today = datetime.now(zone).date()
        start_date, end_date = start_date or today - timedelta(days=29), end_date or today
        if start_date > end_date or (end_date - start_date).days > 3660:
            raise HTTPException(422, "请选择有效的日期范围，最长十年")
        start_at = datetime.combine(start_date, time.min, tzinfo=zone).astimezone(ZoneInfo("UTC")).isoformat(timespec="microseconds")
        end_at = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=zone).astimezone(ZoneInfo("UTC")).isoformat(timespec="microseconds")
        rows = list(db.scalars(select(UsageCall).where(UsageCall.profile_id == config.PROFILE_ID,
            UsageCall.created_at >= start_at, UsageCall.created_at < end_at).order_by(UsageCall.created_at.desc())))
        groups, currencies = {}, {}
        for row in rows:
            currency = (row.price_snapshot or {}).get("currency")
            key = (row.provider_id, row.model_name, row.purpose, currency)
            group = groups.setdefault(key, {"provider_id": row.provider_id, "provider_label": row.provider_label,
                "model_name": row.model_name, "purpose": row.purpose, "currency": currency, "kind": row.kind,
                "calls": 0, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "cache_write_tokens": 0,
                "image_count": 0, "unknown_calls": 0, "known_calls": 0,
                "unknown_input_calls": 0, "unknown_output_calls": 0, "unknown_image_calls": 0,
                "unknown_cached_calls": 0, "unknown_cache_write_calls": 0,
                "known_cost": Decimal(0)})
            group["calls"] += 1
            for field in ("input_tokens", "output_tokens", "cached_tokens", "cache_write_tokens", "image_count"):
                group[field] += getattr(row, field) or 0
            group["unknown_input_calls"] += row.input_tokens is None
            group["unknown_output_calls"] += row.output_tokens is None
            group["unknown_image_calls"] += row.kind == "images" and row.image_count is None
            group["unknown_cached_calls"] += row.cached_tokens is None
            group["unknown_cache_write_calls"] += row.cache_write_tokens is None
            if row.estimated_cost is None:
                group["unknown_calls"] += 1
            else:
                group["known_calls"] += 1
                group["known_cost"] += Decimal(row.estimated_cost)
                currencies[currency] = currencies.get(currency, Decimal(0)) + Decimal(row.estimated_cost)
        for group in groups.values():
            group["known_cost"] = format(group["known_cost"], "f")
        # Old runs retain total Tokens only; report them separately, never allocate a price.
        covered = set(db.scalars(select(UsageCall.run_id).where(UsageCall.run_id.is_not(None))))
        historical = [{"id": row.id, "created_at": row.created_at, "total_tokens": row.usage.get("total_tokens"),
                       "purpose": row.kind, "unknown_reason": "旧运行仅保留总 Token，无法可靠还原逐次用量或费用"}
                      for row in db.scalars(select(Run).where(Run.profile_id == config.PROFILE_ID,
                          Run.created_at >= start_at, Run.created_at < end_at).order_by(Run.created_at.desc()))
                      if row.id not in covered and row.usage.get("total_tokens")]
        totals = [row.total_tokens if row.total_tokens is not None else
                  row.input_tokens + row.output_tokens if row.input_tokens is not None and row.output_tokens is not None
                  else None for row in rows]
        known_totals = [value for value in totals if value is not None] + [row["total_tokens"] for row in historical]
        return {"start_date": str(start_date), "end_date": str(end_date), "total_calls": len(rows),
            "total_tokens": sum(known_totals) if known_totals or not rows else None,
            "unknown_token_calls": sum(value is None for value in totals),
            "unknown_calls": sum(row.estimated_cost is None for row in rows),
            "currencies": {key: format(value, "f") for key, value in currencies.items()},
            "groups": list(groups.values()), "calls": [read_call(row) for row in rows[offset:offset + limit]],
            "offset": offset, "limit": limit, "has_more": offset + limit < len(rows),
            "historical": historical[:100], "historical_count": len(historical)}
