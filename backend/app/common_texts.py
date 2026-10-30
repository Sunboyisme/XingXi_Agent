"""User-managed plain text; never executable instructions or automatic memory."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from . import config, db as store
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


class TextWrite(BaseModel):
    content: str = Field(min_length=1, max_length=50000)
    category_id: str | None = Field(default=None, max_length=36)

    @field_validator("content")
    @classmethod
    def content_not_blank(cls, value):
        if not value.strip():
            raise ValueError("请输入正文")
        return value


class TextRead(RecordRead):
    content: str
    category_id: str | None


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
            .order_by(store.CommonTextCategory.name_key, store.CommonTextCategory.id))]


@router.post("/common-text-categories", response_model=CategoryRead)
def create_category(value: CategoryWrite):
    with store.Session() as db:
        row = store.CommonTextCategory(name=value.name, name_key=value.name.casefold())
        db.add(row)
        commit_category(db)
        return CategoryRead.model_validate(row)


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
            statement = statement.order_by(store.CommonText.category_id.is_(None), store.CommonTextCategory.name_key)
        statement = statement.order_by(store.CommonText.updated_at.desc(), store.CommonText.id)
        return [TextRead.model_validate(row) for row in db.scalars(statement)]


def write_text(db, row, value):
    if value.category_id:
        require(db, store.CommonTextCategory, value.category_id)
    row.content, row.category_id = value.content, value.category_id or None
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "分类已改变，请重新选择后保存") from None
    return TextRead.model_validate(row)


@router.post("/common-texts", response_model=TextRead)
def create_text(value: TextWrite):
    with store.Session() as db:
        return write_text(db, store.CommonText(), value)


@router.put("/common-texts/{identifier}", response_model=TextRead)
def edit_text(identifier: str, value: TextWrite):
    with store.Session() as db:
        return write_text(db, require(db, store.CommonText, identifier), value)


@router.delete("/common-texts/{identifier}")
def delete_text(identifier: str):
    with store.Session() as db:
        db.delete(require(db, store.CommonText, identifier))
        db.commit()
        return {"ok": True}
