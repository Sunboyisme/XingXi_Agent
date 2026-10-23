"""Local read-only access regressions. Not executed as part of this delivery."""

import io
import json
import os
import pytest
from PIL import Image

from app import complex_tasks, file_tools, local_files, office, office_formats, tools
from app.db import Conversation, Message, Run, Session


def conversation(text, *, role="user", created_at="2026-10-23T06:00:00.000000+00:00"):
    with Session() as db:
        chat = Conversation(title="只读本地文件")
        db.add(chat)
        db.flush()
        message = Message(conversation_id=chat.id, role=role, content=text, created_at=created_at)
        db.add(message)
        db.flush()
        run = Run(kind="chat", conversation_id=chat.id, source_message_id=message.id)
        db.add(run)
        db.commit()
        return chat.id, run.id, message.id


def add_message(chat_id, text, role="user", created_at="2026-10-23T06:00:00.000000+00:00"):
    with Session() as db:
        message = Message(conversation_id=chat_id, role=role, content=text, created_at=created_at)
        db.add(message)
        db.commit()
        return message.id


async def test_read_chinese_path_with_spaces_and_preserve_original(tmp_path):
    folder = tmp_path / "中文 项目"
    folder.mkdir()
    path = folder / "需求说明.md"
    original = ("第一行\n" + "正文与数字123\n" * 3000).encode("utf-8")
    path.write_bytes(original)
    before = path.stat()
    cid, rid, _ = conversation(f"请读取 `{path}`，并总结")
    first = await local_files.read_file(str(path), rid, cid, count=10)
    assert first["path"] == str(path.resolve())
    assert sum(len(part["text"]) for part in first["parts"]) <= 18_000
    assert first["next_start"] is not None
    second = await local_files.read_file(str(path), rid, cid, start=first["next_start"], count=10)
    assert second["parts"][0]["part"] > first["parts"][-1]["part"]
    assert path.read_bytes() == original
    assert path.stat().st_mtime_ns == before.st_mtime_ns
    assert sorted(item.name for item in folder.iterdir()) == [path.name]


async def test_file_mention_does_not_authorize_sibling_or_similar_prefix(tmp_path):
    named = tmp_path / "allowed.txt"
    sibling = tmp_path / "secret.txt"
    named.write_text("公开正文", encoding="utf-8")
    sibling.write_text("另一个文件", encoding="utf-8")
    cid, rid, _ = conversation(f"读取 `{named}`")
    assert (await local_files.read_file(str(named), rid, cid))["parts"]
    with pytest.raises(ValueError, match="范围"):
        await local_files.read_file(str(sibling), rid, cid)
    with pytest.raises(ValueError, match="范围"):
        local_files.scan_folder(str(tmp_path), rid, cid)


async def test_scope_uses_only_user_messages_before_current_run(tmp_path):
    path = tmp_path / "private.txt"
    path.write_text("不应读取", encoding="utf-8")
    cid, rid, _ = conversation("先说明你的能力")
    # Same-time messages added after this run's source must not grant access.
    add_message(cid, f"读取 `{path}`")
    add_message(cid, f"可读取 `{tmp_path}`", role="assistant", created_at="2026-10-23T05:00:00.000000+00:00")
    conversation(f"读取 `{tmp_path}`")
    with pytest.raises(ValueError, match="范围"):
        await local_files.read_file(str(path), rid, cid)


async def test_folder_scope_can_be_reused_by_later_user_message(tmp_path):
    nested = tmp_path / "子目录"
    nested.mkdir()
    path = nested / "内容.txt"
    path.write_text("继续读取", encoding="utf-8")
    cid, _, _ = conversation(f"扫描 `{tmp_path}`")
    message_id = add_message(cid, "读取刚才的内容文件")
    with Session() as db:
        run = Run(kind="chat", conversation_id=cid, source_message_id=message_id)
        db.add(run)
        db.commit()
        rid = run.id
    assert "继续读取" in (await local_files.read_file(str(path), rid, cid))["parts"][0]["text"]


def test_folder_scan_pagination_recursion_filter_and_hidden_items(tmp_path):
    nested = tmp_path / "子目录"
    nested.mkdir()
    for name in ("a.md", "b.md", "c.txt", ".hidden.md"):
        (tmp_path / name).write_text("正文", encoding="utf-8")
    (nested / "d.md").write_text("子目录正文", encoding="utf-8")
    cid, rid, _ = conversation(f"扫描 `{tmp_path}`")
    first = local_files.scan_folder(str(tmp_path), rid, cid, pattern="*.md", limit=1)
    second = local_files.scan_folder(str(tmp_path), rid, cid, pattern="*.md", limit=1, offset=first["next_offset"])
    assert [item["name"] for item in first["entries"] + second["entries"]] == ["a.md", "b.md"]
    assert second["next_offset"] is None
    deep = local_files.scan_folder(str(tmp_path), rid, cid, recursive=True, pattern="*.md")
    assert {item["name"] for item in deep["entries"]} == {"a.md", "b.md", "d.md"}
    hidden = local_files.scan_folder(str(tmp_path), rid, cid, pattern="*.md", include_hidden=True)
    assert ".hidden.md" in {item["name"] for item in hidden["entries"]}
    shallow = local_files.scan_folder(str(tmp_path), rid, cid, recursive=True, max_depth=1)
    assert shallow["partial"] and shallow["warnings"]
    assert "d.md" not in {item["name"] for item in shallow["entries"]}


def test_scan_reports_limits_instead_of_claiming_all_files(tmp_path, monkeypatch):
    for index in range(10):
        (tmp_path / f"{index}.txt").write_text("正文", encoding="utf-8")
    cid, rid, _ = conversation(f"扫描 `{tmp_path}`")
    monkeypatch.setattr(local_files, "MAX_SCAN_ENTRIES", 3)
    result = local_files.scan_folder(str(tmp_path), rid, cid)
    assert result["examined_entries"] == 3
    assert result["returned"] <= 3
    assert result["partial"] and result["warnings"]


async def test_scan_skips_links_and_read_cannot_escape_directory_scope(tmp_path):
    allowed = tmp_path / "授权目录"
    allowed.mkdir()
    outside = tmp_path / "其他目录"
    outside.mkdir()
    (outside / "private.txt").write_text("不可越界", encoding="utf-8")
    link = allowed / "链接"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("当前 Windows 用户没有创建符号链接的权限")
    cid, rid, _ = conversation(f"扫描 `{allowed}`")
    scan = local_files.scan_folder(str(allowed), rid, cid, recursive=True)
    assert scan["entries"] == []
    assert scan["skipped_entries"] == 1
    with pytest.raises(ValueError, match="范围"):
        await local_files.read_file(str(link / "private.txt"), rid, cid)


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "gb18030"])
async def test_local_text_encodings_and_code_is_never_executed(tmp_path, encoding):
    path = tmp_path / "资料.py"
    content = "# 中文代码\nraise RuntimeError('必须只作为文字读取')\n"
    path.write_bytes(content.encode(encoding))
    cid, rid, _ = conversation(f"读取 `{path}`")
    result = await local_files.read_file(str(path), rid, cid)
    assert "必须只作为文字读取" in result["parts"][0]["text"]


async def test_local_office_formats_use_existing_parser_without_import(tmp_path):
    path = tmp_path / "报告.docx"
    original = office_formats.document("docx", "项目报告", [{"kind": "paragraph", "text": "预算100元"}])
    path.write_bytes(original)
    cid, rid, _ = conversation(f"读取 `{path}`")
    result = await local_files.read_file(str(path), rid, cid)
    assert "预算100元" in json.dumps(result, ensure_ascii=False)
    assert office.list_files(cid) == []
    assert path.read_bytes() == original


async def test_local_images_use_vision_reader_and_keep_source(tmp_path, monkeypatch):
    output = io.BytesIO()
    Image.new("RGB", (10, 10), "white").save(output, format="PNG")
    path = tmp_path / "截图.png"
    path.write_bytes(output.getvalue())
    cid, rid, _ = conversation(f"读取 `{path}`")
    calls = []

    async def read_image(raw, media_type, run_id, question):
        calls.append((raw, media_type, run_id, question))
        return office.ImageReading(content="测试图片", uncertainties=[])

    monkeypatch.setattr(office, "read_image", read_image)
    result = await local_files.read_file(str(path), rid, cid, question="提取数字")
    assert result["kind"] == "image"
    assert calls == [(output.getvalue(), "image/png", rid, "提取数字")]
    assert path.read_bytes() == output.getvalue()


async def test_rejected_paths_binary_size_and_tool_error_messages(tmp_path):
    for value in ("relative.txt", "https://example.com/a.txt", r"\\server\share\a.txt", r"\\?\C:\file.txt"):
        with pytest.raises(ValueError):
            local_files.local_path(value)
    if os.name == "nt":
        with pytest.raises(ValueError):
            local_files.local_path(r"C:\file.txt:stream")
    binary = tmp_path / "binary.txt"
    binary.write_bytes(b"abc\x00def")
    cid, rid, _ = conversation(f"扫描 `{tmp_path}`")
    with pytest.raises(ValueError, match="二进制"):
        await local_files.read_file(str(binary), rid, cid)
    oversized = tmp_path / "too-large.txt"
    with oversized.open("wb") as stream:
        stream.truncate(local_files.LIMIT + 1)
    with pytest.raises(ValueError, match="20 MB"):
        await local_files.read_file(str(oversized), rid, cid)
    toolmap = {item.name: item for item in file_tools.build(rid, cid)}
    missing = json.loads(await toolmap["read_local_file"].ainvoke({"path": str(tmp_path / "missing.txt")}))
    assert "不存在" in missing["error"] and missing["not_executed"]
    assert not missing["retryable"]


async def test_local_tools_are_catalogued_switchable_and_read_only(tmp_path):
    cid, rid, _ = conversation(f"扫描 `{tmp_path}`")
    catalog = {item["id"]: item for item in tools.tool_catalog()}
    assert {"read_local_file", "scan_local_folder"} <= complex_tasks.READ_TOOLS
    assert catalog["read_local_file"]["available"]
    assert catalog["scan_local_folder"]["parameters"]["properties"]["recursive"]["default"] is False
    tools.set_tool_enabled("scan_local_folder", False)
    entry = next(item for item in tools.tool_catalog() if item["id"] == "scan_local_folder")
    originals = {item.name: item for item in file_tools.build(rid, cid)}
    guarded = tools._guard_tool(entry, originals, rid)
    result = json.loads(await guarded(path=str(tmp_path)))
    assert "已关闭" in result["error"]
