"""Local lossless image assets. Editable sources are separate from chat uploads."""
import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import select

from . import config
from . import db as store
from .schemas import RecordRead

router = APIRouter()
lock = RLock()
LIMIT = 32 * 1024 * 1024
PIXELS = 80_000_000


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float
    y: float


class Mark(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    tool: Literal["pen", "line", "arrow", "rect", "ellipse", "text", "mosaic"]
    points: list[Point] = Field(min_length=1, max_length=100000)
    color: str = Field(pattern=r"^#[a-fA-F0-9]{6}$")
    width: float = Field(gt=0, le=100)
    size: float = Field(gt=0, le=512)
    text: str | None = Field(default=None, max_length=50000)


class Scene(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    marks: list[Mark] = Field(max_length=5000)

    @model_validator(mode="after")
    def valid_geometry(self):
        if self.width * self.height > PIXELS or any(abs(point.x) > PIXELS or abs(point.y) > PIXELS for mark in self.marks for point in mark.points):
            raise ValueError("图片标注坐标或尺寸无效")
        return self


class AssetRead(RecordRead):
    name: str
    media_type: str
    width: int
    height: int
    scene: Scene | None


def folder():
    return config.ATTACHMENTS_DIR / "common-texts"


def path(identifier, original=False):
    return folder() / f"{identifier}{'.bin' if original else '.png'}"


def require(db, identifier):
    row = db.get(store.CommonTextAsset, identifier)
    if row is None or row.profile_id != config.PROFILE_ID:
        raise HTTPException(404, "图片不存在或已删除，请重新添加")
    return row


def image_ids(document):
    return {block["asset_id"] for block in (document or {}).get("blocks", []) if block.get("type") == "image"}


def referenced(db):
    return set().union(set(), *(image_ids(doc) for doc in db.scalars(select(store.CommonText.document)
        .where(store.CommonText.profile_id == config.PROFILE_ID))))


def cleanup(db, candidates):
    for identifier in set(candidates) - referenced(db):
        row = db.get(store.CommonTextAsset, identifier)
        if row is not None and row.profile_id == config.PROFILE_ID:
            # Remove database references before files; failed unlink is recoverable.
            db.delete(row)
            db.commit()
            for target in (path(identifier), path(identifier, True)):
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    pass


def recover():
    with lock, store.Session() as db:
        cutoff = (datetime.now(UTC) - timedelta(days=1)).isoformat()
        cleanup(db, list(db.scalars(select(store.CommonTextAsset.id).where(
            store.CommonTextAsset.profile_id == config.PROFILE_ID, store.CommonTextAsset.created_at < cutoff))))
        if folder().exists():
            known = set(db.scalars(select(store.CommonTextAsset.id)))
            for target in folder().iterdir():
                if target.suffix in {".bin", ".png"} and target.stem not in known:
                    try:
                        target.unlink()
                    except OSError:
                        pass


def decode(raw):
    try:
        image = Image.open(io.BytesIO(raw))
        if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > PIXELS:
            raise ValueError()
        return ImageOps.exif_transpose(image).convert("RGBA")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "请添加有效的 PNG、JPG 或 WebP 图片，图片不能超过 8,000 万像素") from None


@router.post("/common-text-assets", response_model=AssetRead)
async def upload(file: Annotated[UploadFile, File()], rendered: Annotated[UploadFile | None, File()] = None,
                 scene: Annotated[str | None, Form(max_length=8 * 1024 * 1024)] = None):
    raw = await file.read(LIMIT + 1)
    output = await rendered.read(LIMIT + 1) if rendered else raw
    if len(raw) > LIMIT or len(output) > LIMIT:
        raise HTTPException(413, "单张图片不能超过 32 MB")
    source = decode(raw)
    result = decode(output) if rendered else source
    if source.size != result.size:
        raise HTTPException(422, "原图与编辑后图片的尺寸不一致")
    try:
        value = Scene.model_validate_json(scene) if scene else None
    except ValidationError:
        raise HTTPException(422, "图片标注数据无效，请重新编辑后保存") from None
    if value and (value.width, value.height) != source.size:
        raise HTTPException(422, "图片标注与原图的尺寸不一致")
    if rendered and not value:
        raise HTTPException(422, "编辑后的图片缺少标注数据")
    with lock, store.Session() as db:
        row = store.CommonTextAsset(name=Path(file.filename or "图片.png").name[:300], media_type="image/png",
            width=source.width, height=source.height, scene=value.model_dump() if value else None)
        db.add(row)
        db.flush()
        try:
            folder().mkdir(exist_ok=True)
            source.save(path(row.id, True), "PNG")
            result.save(path(row.id), "PNG")
            if path(row.id, True).stat().st_size > LIMIT or path(row.id).stat().st_size > LIMIT:
                raise HTTPException(413, "图片无损编码后超过 32 MB，请缩小图片后添加")
            db.commit()
        except Exception as error:
            db.rollback()
            for target in (path(row.id, True), path(row.id)):
                try:
                    target.unlink(missing_ok=True)
                except OSError:
                    pass
            if isinstance(error, OSError):
                raise HTTPException(507, "图片保存失败，请检查磁盘空间后重试") from None
            raise
        return AssetRead.model_validate(row)


@router.get("/common-text-assets/{identifier}", response_model=AssetRead)
def read(identifier: str):
    with store.Session() as db:
        return AssetRead.model_validate(require(db, identifier))


@router.get("/common-text-assets/{identifier}/content")
def content(identifier: str):
    with store.Session() as db:
        require(db, identifier)
        if not path(identifier).is_file():
            raise HTTPException(404, "图片文件缺失，请重新添加")
        return FileResponse(path(identifier), media_type="image/png")


@router.get("/common-text-assets/{identifier}/original")
def original(identifier: str):
    with store.Session() as db:
        require(db, identifier)
        if not path(identifier, True).is_file():
            raise HTTPException(404, "图片原文件缺失，请重新添加")
        return FileResponse(path(identifier, True), media_type="image/png")


@router.delete("/common-text-assets/{identifier}")
def delete(identifier: str):
    with lock, store.Session() as db:
        require(db, identifier)
        if identifier in referenced(db):
            raise HTTPException(409, "图片仍在使用，请先保存正文修改")
        cleanup(db, [identifier])
    return {"ok": True}


def validate_portable(connection, stage):
    """Validate every document and image before a portable archive is accepted."""
    from .common_texts import Document
    assets = {}
    for identifier, width, height, raw_scene in connection.execute("SELECT id, width, height, scene FROM common_text_assets"):
        if len(identifier) != 36 or any(char not in "abcdef0123456789-" for char in identifier):
            raise ValueError("常用文本图片记录无效")
        if width <= 0 or height <= 0 or width * height > PIXELS:
            raise ValueError("常用文本图片尺寸无效")
        if raw_scene and raw_scene != "null":
            scene = Scene.model_validate(json.loads(raw_scene))
            if (scene.width, scene.height) != (width, height):
                raise ValueError("常用文本标注尺寸不一致")
        for suffix in (".bin", ".png"):
            if not (stage / "attachments" / "common-texts" / f"{identifier}{suffix}").is_file():
                raise ValueError("常用文本图片文件缺失")
        assets[identifier] = True
    for (raw,) in connection.execute("SELECT document FROM common_texts WHERE document IS NOT NULL"):
        if raw and raw != "null":
            document = Document.model_validate(json.loads(raw)).model_dump()
            if image_ids(document) - assets.keys():
                raise ValueError("常用文本引用的图片缺失")
