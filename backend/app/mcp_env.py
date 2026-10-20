"""Explicit, one-pass environment references in MCP credential values."""

import os
import re

REFERENCE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class EnvironmentReferenceError(ValueError):
    pass


def windows_environment(name):
    if os.name != "nt":
        return None
    import winreg

    for hive, path in (
        (winreg.HKEY_CURRENT_USER, r"Environment"),
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ):
        try:
            with winreg.OpenKey(hive, path) as key:
                value, kind = winreg.QueryValueEx(key, name)
                if kind in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) and isinstance(value, str):
                    return value
        except OSError:
            continue
    return None


def environment(name):
    # Explicit process overrides win. Read newly added Windows user/system values
    # without requiring the already running desktop launcher to inherit them.
    return os.environ[name] if name in os.environ else windows_environment(name)


def resolve(value, *, header=False):
    if "${" in REFERENCE.sub("", value):
        raise EnvironmentReferenceError("环境变量引用格式无效，请使用 ${变量名}。")
    secrets = []
    invalid = "\r\n\0" if header else "\0"

    def replace(match):
        name = match.group(1)
        resolved = environment(name)
        if not resolved:
            raise EnvironmentReferenceError(f"未找到或为空的环境变量：{name}。请配置后重新测试连接。")
        if len(resolved) > 8192 or any(char in resolved for char in invalid):
            raise EnvironmentReferenceError(f"环境变量 {name} 的值不适用于 MCP 凭据。")
        secrets.append(resolved)
        return resolved

    result = REFERENCE.sub(replace, value)
    if len(result) > 8192 or any(char in result for char in invalid):
        raise EnvironmentReferenceError("MCP 凭据过长或包含不支持的换行字符。")
    return result, secrets


def template(value):
    """Expose only a simple reference, never a resolved or literal API key."""
    return value if re.fullmatch(r"(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}", value, re.I) else ""
