"""Offline example: no third-party dependencies, no network access."""

import os
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("用法：make_note.py 标题 正文")

folder = Path(os.environ["XIAOXI_OUTPUT_DIR"])
folder.mkdir(parents=True, exist_ok=True)
target = folder / "小笔记.md"
target.write_text(f"# {sys.argv[1]}\n\n{sys.argv[2]}\n", encoding="utf-8")
print("笔记已保存：小笔记.md")
