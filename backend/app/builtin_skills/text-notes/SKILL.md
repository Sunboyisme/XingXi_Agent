---
name: text-notes
description: 将你提供的内容整理成结构清晰的 Markdown 笔记，并生成可保存的文件。
---

# 整理一份小笔记

1. 读取 `references/format.md`，了解输出格式。
2. 根据用户给出的内容准备一个简洁标题和笔记正文；不要添加未提供的事实。
3. 调用 `run_skill_script`，path 为 `scripts/make_note.py`，arguments 为 `[标题, 正文]`。
4. 仅在脚本成功后告诉用户文件已生成，并展示工具返回的文件。

脚本不访问网络，不需要第三方 Python 包。未授权脚本时，引导用户在“设置 → 技能”中开启本技能的脚本权限。
