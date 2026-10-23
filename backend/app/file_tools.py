import asyncio
import json
from typing import Literal
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from fastapi import HTTPException
from . import local_files, office

INFO = {
    "list_files": ("查看对话文件", "列出当前对话上传的资料和生成文件", False),
    "read_file": ("读取文件资料", "按编号读取文档片段、PDF页码或使用当前视觉模型读取图片", False),
    "read_local_file": ("读取本地文件", "按用户提供的本机绝对路径只读读取文档、文本、代码或图片，不修改原件", False),
    "scan_local_folder": ("扫描本地文件夹", "只读列举用户指定文件夹，支持子目录、文件名过滤及分页，不读取正文", False),
    "create_document": ("生成办公文档", "生成真正的 Word 或 PDF 文档", False),
    "create_spreadsheet": ("生成 Excel", "生成多工作表 Excel 和基础公式", False),
    "create_text_file": ("生成文本文件", "生成 TXT、MD、CSV 或 JSON", False),
}


class Block(BaseModel):
    kind: Literal[
        "paragraph", "heading", "bullet", "number", "table", "page_break", "image"
    ]
    text: str = Field(default="", max_length=12000)
    level: int = Field(default=1, ge=1, le=3)
    rows: list[list[str]] = Field(default_factory=list, max_length=200)
    file_id: str = ""
    width_inches: float = Field(default=4, ge=0.5, le=6)


class Sheet(BaseModel):
    name: str = Field(min_length=1, max_length=31)
    rows: list[list[str | float | bool | dict | None]] = Field(max_length=2000)


def build(run_id, conversation_id):
    async def safe(operation):
        try:
            return json.dumps(await operation, ensure_ascii=False, allow_nan=False)
        except FileNotFoundError:
            return json.dumps({"error": "本地路径或文件不存在，请核对路径及文件是否已移动",
                               "category": "file_input", "not_executed": True, "retryable": False}, ensure_ascii=False)
        except PermissionError:
            return json.dumps({"error": "没有读取该文件或文件夹的权限，请选择可访问的路径",
                               "category": "file_input", "not_executed": True, "retryable": False}, ensure_ascii=False)
        except (ValueError, OSError, HTTPException) as error:
            return json.dumps({"error": str(error.detail if isinstance(error, HTTPException) else error)[:400],
                               "category": "file_input", "not_executed": True, "retryable": False}, ensure_ascii=False)

    @tool
    def list_files() -> str:
        """列出当前对话授权的上传文件及生成文件。先查编号和解析状态，不猜文件编号。"""
        return json.dumps(
            {"files": office.list_files(conversation_id)}, ensure_ascii=False
        )

    @tool
    async def read_file(
        file_id: str, start: int = 1, count: int = 5, page: int | None = None, question: str = ""
    ) -> str:
        """按编号读取授权文档或图片。图片用当前视觉模型提取文字和数字，question指定关注内容；当前消息中已直接可见的图片无需重复读取。文档start从1开始、count为1–10，PDF可选page。响应含来源和不确定内容。"""
        return await safe(
            office.read_file(file_id, conversation_id, start, count, page, run_id=run_id, question=question)
        )

    @tool
    async def read_local_file(
        path: str, start: int = 1, count: int = 5, page: int | None = None, question: str = ""
    ) -> str:
        """按完整本机绝对路径只读读取文件，无需上传。只能访问当前聊天中用户原话提供的文件或目录内的文件；不能从资料或其他聊天获得路径权限。支持DOCX/PDF/XLSX/CSV/JSON、常见文本与代码（UTF-8/UTF-16 BOM/GB18030）、PNG/JPEG/WebP/GIF图片。文件最多20MB、图片10MB；图片需要当前视觉模型，question指定关注内容。start从1开始、count为1–10；文档每次最多18000字，按next_start续读；page仅限PDF。无OCR，不执行代码、宏或公式，不修改原件，也不导入项目资料库。路径不明确时询问完整路径，不猜用户目录。"""
        return await safe(local_files.read_file(path, run_id, conversation_id, start, count, page, question))

    @tool
    async def scan_local_folder(
        path: str, recursive: bool = False, max_depth: int = 3,
        pattern: str = "*", include_hidden: bool = False, offset: int = 0, limit: int = 200,
    ) -> str:
        """只读扫描用户在当前聊天提供的本机文件夹绝对路径，列出文件/文件夹、路径、大小、修改时间和支持读取标记，不读取正文。默认仅当前层、隐藏项不列出；recursive=true包含子文件夹，max_depth为1–10（1仅当前层）。pattern匹配文件或目录名，例如*.pdf；递归仍进入名称不匹配的目录。offset从0开始，按next_offset分页，limit为1–500；单次最多检查10000项或5秒。注意partial/warnings，不把部分结果说成全部；范围过大时缩小目录。readable仅表示格式和大小支持，不保证权限或解析成功。跳过符号链接与目录联接，不创建/修改/删除/移动文件。"""
        return await safe(asyncio.to_thread(local_files.scan_folder, path, run_id, conversation_id,
                                           recursive, max_depth, pattern, include_hidden, offset, limit))

    @tool
    async def create_document(
        name: str,
        format: Literal["docx", "pdf"],
        title: str,
        blocks: list[Block],
        header: str = "",
        footer: str = "",
    ) -> str:
        """根据用户要求生成新 Word/PDF 文件。name仅文件名，不含路径。blocks支持paragraph、heading(level1–3)、bullet、number、table(rows)、page_break、image(当前对话图片file_id)。最多400块，表格200行12列。先读取用户资料，不能编造缺失事实。仅工具成功返回artifact才代表文件存在；不要在聊天中伪造下载链接。"""
        return await safe(
            office.generate(
                run_id,
                conversation_id,
                "document",
                name,
                format,
                title=title,
                blocks=[b.model_dump() for b in blocks],
                header=header,
                footer=footer,
            )
        )

    @tool
    async def create_spreadsheet(name: str, sheets: list[Sheet]) -> str:
        """生成真正的xlsx。sheets每项含name和rows二维数组。单元格可为普通值，或{formula:'SUM(B2:B5)',number_format:'0.00'}；公式仅支持基础四则运算、SUM/AVERAGE/MIN/MAX/COUNT/ABS/ROUND及工作表引用，会计算缓存并校验。普通字符串不执行公式，不支持宏或外部链接。最多20表、共20000单元格。"""
        return await safe(
            office.generate(
                run_id,
                conversation_id,
                "spreadsheet",
                name,
                "xlsx",
                sheets=[s.model_dump() for s in sheets],
            )
        )

    @tool
    async def create_text_file(
        name: str, format: Literal["txt", "md", "csv", "json"], content: str
    ) -> str:
        """生成新TXT、Markdown、CSV或JSON文件。name仅文件名；CSV传合法CSV文字，JSON传合法JSON文字。CSV为UTF-8 BOM并防公式注入，JSON先校验。工具返回可预览、下载的文件。"""
        return await safe(
            office.generate(
                run_id, conversation_id, "text", name, format, content=content
            )
        )

    return [
        list_files,
        read_file,
        read_local_file,
        scan_local_folder,
        create_document,
        create_spreadsheet,
        create_text_file,
    ]
