"""Private subprocess protocol. Never accepts paths, shell commands or Python code."""

import base64
import json
import sys


def main():
    from . import office_formats as fmt

    try:
        request = json.loads(sys.stdin.buffer.read(35 * 1024 * 1024))
        operation = request["operation"]
        calculations = []
        if operation == "parse":
            value = fmt.parse(
                base64.b64decode(request["data"], validate=True),
                request["name"],
                cached=request.get("cached", False),
            )
        elif operation == "pdf_page":
            value = fmt.pdf_page(
                base64.b64decode(request["data"], validate=True), request.get("page", 1)
            )
        else:
            if operation == "document":
                raw = fmt.document(
                    request["format"],
                    request.get("title", ""),
                    request["blocks"],
                    request.get("header", ""),
                    request.get("footer", ""),
                )
            elif operation == "spreadsheet":
                raw, calculations = fmt.spreadsheet(request["sheets"], with_values=True)
            elif operation == "text":
                raw = fmt.text_file(request["format"], request.get("content"), request.get("rows"))
            else:
                raise ValueError("未知文件操作")
            if not raw or len(raw) > fmt.LIMIT:
                raise ValueError("生成文件为空或超过 20 MB")
            value = {"data": base64.b64encode(raw).decode(), "calculations": calculations}
        print(json.dumps(value, ensure_ascii=True, allow_nan=False))
    except Exception as error:
        known = isinstance(
            error, (ValueError, ZeroDivisionError, SyntaxError, json.JSONDecodeError)
        )
        print(
            json.dumps(
                {
                    "error": str(error)[:400]
                    if known
                    else "文件解析或生成失败，请检查格式；损坏、加密或不支持的内容无法处理"
                },
                ensure_ascii=True,
            )
        )


if __name__ == "__main__":
    main()
