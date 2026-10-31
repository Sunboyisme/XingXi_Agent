"""User-managed text and image documents; never executable instructions or automatic memory."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError

from . import common_text_assets as assets
from . import config
from . import db as store
from .schemas import RecordRead

router = APIRouter()


class CategoryWrite(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        value = value.strip()
        if not value or value == "默认分类":
            raise ValueError("请输入分类名称，不使用保留名称“默认分类”")
        return value


class CategoryRead(RecordRead):
    name: str


class TextBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["text"]
    text: str = Field(max_length=50000)


class ImageBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["image"]
    asset_id: str = Field(pattern=r"^[a-f0-9-]{36}$")


class Document(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    blocks: list[TextBlock | ImageBlock] = Field(max_length=2000)

    @model_validator(mode="after")
    def valid(self):
        text = "\n".join(block.text for block in self.blocks if block.type == "text")
        if len(text) > 50000:
            raise ValueError("正文不能超过 50,000 字符")
        if not text.strip() and not any(block.type == "image" for block in self.blocks):
            raise ValueError("请输入文字或添加图片")
        return self


class TextWrite(BaseModel):
    content: str = Field(default="", max_length=50000)
    document: Document | None = None
    category_id: str | None = Field(default=None, max_length=36)
    expected_updated_at: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def nonempty(self):
        if self.document is None and not self.content.strip():
            raise ValueError("请输入文字或添加图片")
        return self


class TextRead(RecordRead):
    content: str
    category_id: str | None
    document: Document | None = None


class CategoryOrder(BaseModel):
    category_ids: list[str] = Field(max_length=2000)


def require(db, model, identifier):
    row = db.get(model, identifier)
    if row is None or row.profile_id != config.PROFILE_ID:
        raise HTTPException(404, "内容不存在或已删除，请重新读取")
    return row


def commit_category(db):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "已存在同名分类，请使用其他名称") from None


@router.get("/common-text-categories", response_model=list[CategoryRead])
def categories():
    with store.Session() as db:
        return [CategoryRead.model_validate(row) for row in db.scalars(
            select(store.CommonTextCategory).where(store.CommonTextCategory.profile_id == config.PROFILE_ID)
            .order_by(store.CommonTextCategory.sort_order, store.CommonTextCategory.name_key, store.CommonTextCategory.id))]


@router.post("/common-text-categories", response_model=CategoryRead)
def create_category(value: CategoryWrite):
    with store.Session() as db:
        order = db.scalar(select(func.max(store.CommonTextCategory.sort_order)).where(store.CommonTextCategory.profile_id == config.PROFILE_ID))
        row = store.CommonTextCategory(name=value.name, name_key=value.name.casefold(), sort_order=(order if order is not None else -1) + 1)
        db.add(row)
        commit_category(db)
        return CategoryRead.model_validate(row)


@router.patch("/common-text-categories/order", response_model=list[CategoryRead])
def order_categories(value: CategoryOrder):
    with assets.lock, store.Session() as db:
        rows = list(db.scalars(select(store.CommonTextCategory).where(store.CommonTextCategory.profile_id == config.PROFILE_ID)))
        if len(set(value.category_ids)) != len(value.category_ids) or set(value.category_ids) != {row.id for row in rows}:
            raise HTTPException(409, "分类已改变，请刷新后重新排序")
        positions = {identifier: index for index, identifier in enumerate(value.category_ids)}
        for row in rows:
            row.sort_order = positions[row.id]
        db.commit()
        return [CategoryRead.model_validate(row) for row in sorted(rows, key=lambda row: row.sort_order)]


@router.put("/common-text-categories/{identifier}", response_model=CategoryRead)
def edit_category(identifier: str, value: CategoryWrite):
    with store.Session() as db:
        row = require(db, store.CommonTextCategory, identifier)
        row.name, row.name_key = value.name, value.name.casefold()
        commit_category(db)
        return CategoryRead.model_validate(row)


@router.delete("/common-text-categories/{identifier}")
def delete_category(identifier: str):
    with store.Session() as db:
        row = require(db, store.CommonTextCategory, identifier)
        db.execute(update(store.CommonText).where(
            store.CommonText.profile_id == config.PROFILE_ID, store.CommonText.category_id == identifier
        ).values(category_id=None))
        db.delete(row)
        db.commit()
        return {"ok": True}


@router.get("/common-texts", response_model=list[TextRead])
def texts(q: str = Query(default="", max_length=500), category_id: str | None = None,
          sort: Literal["category", "updated"] = "category"):
    with store.Session() as db:
        statement = select(store.CommonText).outerjoin(store.CommonTextCategory).where(
            store.CommonText.profile_id == config.PROFILE_ID)
        if q.strip():
            query = q.strip()
            statement = statement.where(or_(store.CommonText.content.icontains(query, autoescape=True),
                                            store.CommonTextCategory.name.icontains(query, autoescape=True),
                                            store.CommonText.category_id.is_(None) if query.casefold() in "默认分类" else False))
        if category_id == "uncategorized":
            statement = statement.where(store.CommonText.category_id.is_(None))
        elif category_id:
            require(db, store.CommonTextCategory, category_id)
            statement = statement.where(store.CommonText.category_id == category_id)
        if sort == "category":
            statement = statement.order_by(store.CommonText.category_id.is_(None), store.CommonTextCategory.sort_order, store.CommonTextCategory.name_key)
        statement = statement.order_by(store.CommonText.updated_at.desc(), store.CommonText.id)
        return [TextRead.model_validate(row) for row in db.scalars(statement)]


def write_text(db, row, value):
    if value.expected_updated_at is not None and row.updated_at != value.expected_updated_at:
        raise HTTPException(409, "内容已在其他窗口修改，当前草稿已保留，请核对最新内容后重新编辑。")
    if value.category_id:
        require(db, store.CommonTextCategory, value.category_id)
    previous = assets.image_ids(row.document)
    if value.document is None and previous:
        raise HTTPException(409, "图文内容需要使用图文编辑器保存，原图片已保留")
    document = value.document.model_dump() if value.document else {"version": 1, "blocks": [{"type": "text", "text": value.content}]}
    for identifier in assets.image_ids(document):
        assets.require(db, identifier)
    row.content = "\n".join(block["text"] for block in document["blocks"] if block["type"] == "text")
    row.document, row.category_id = document, value.category_id or None
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "分类已改变，请重新选择后保存") from None
    result = TextRead.model_validate(row)
    assets.cleanup(db, previous - assets.image_ids(document))
    return result


@router.post("/common-texts", response_model=TextRead)
def create_text(value: TextWrite):
    with assets.lock, store.Session() as db:
        return write_text(db, store.CommonText(), value)


@router.put("/common-texts/{identifier}", response_model=TextRead)
def edit_text(identifier: str, value: TextWrite):
    with assets.lock, store.Session() as db:
        return write_text(db, require(db, store.CommonText, identifier), value)


@router.delete("/common-texts/{identifier}")
def delete_text(identifier: str):
    with assets.lock, store.Session() as db:
        row = require(db, store.CommonText, identifier)
        images = assets.image_ids(row.document)
        db.delete(row)
        db.commit()
        assets.cleanup(db, images)
        return {"ok": True}
