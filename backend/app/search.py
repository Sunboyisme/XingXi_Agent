from urllib.parse import urlparse
import ipaddress
import httpx
from .config import secret_get
from .provider import ConfigurationError


def public_url(url: str) -> str:
    parsed = urlparse(url)
    if (
        parsed.scheme not in ("https", "http")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("只支持公开的 HTTP/HTTPS 网页")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise ValueError("不读取本机或内网地址")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return url
    if not address.is_global:
        raise ValueError("不读取本机或内网地址")
    return url


async def search_web(query: str) -> dict:
    key = secret_get("search")
    if not key:
        raise ConfigurationError(
            "尚未配置搜索 API，无法联网查证。请在设置中填写 Tavily 密钥。"
        )
    async with httpx.AsyncClient(timeout=25) as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": key,
                "query": query,
                "max_results": 5,
                "include_answer": False,
            },
        )
        response.raise_for_status()
        data = response.json()
        return {
            "query": query,
            "results": [
                {
                    "title": x.get("title"),
                    "url": x.get("url"),
                    "summary": x.get("content", "")[:4000],
                }
                for x in data.get("results", [])
            ],
        }


async def read_webpage(url: str) -> dict:
    public_url(url)
    key = secret_get("search")
    if not key:
        raise ConfigurationError("尚未配置搜索 API，无法读取网页正文。")
    # One extraction budget belongs to this layer, including transient errors.
    errors = []
    async with httpx.AsyncClient(timeout=35) as client:
        for depth in ("basic", "advanced"):
            try:
                response = await client.post("https://api.tavily.com/extract", json={
                    "api_key": key, "urls": [url], "extract_depth": depth,
                    "timeout": 10 if depth == "basic" else 25})
                response.raise_for_status()
                data = response.json()
                for item in data.get("results", []):
                    content = item.get("raw_content", "")
                    if isinstance(content, str) and content.strip():
                        return {"url": item.get("url") or url, "content": content[:18000],
                                "partial": len(content) > 18000, "extraction_depth": depth}
                errors.extend(str(item.get("error", "正文为空"))[:300] for item in data.get("failed_results", []))
            except httpx.HTTPStatusError as error:
                errors.append(f"网页服务返回 HTTP {error.response.status_code}")
                if error.response.status_code in {401, 403, 429}:
                    break
            except (httpx.HTTPError, ValueError):
                errors.append("网页服务暂时无法连接或响应无效")
    return {"url": url, "error": "暂时无法读取这个网页的正文，可以换一个来源继续。",
            "details": errors[-2:], "category": "webpage_unavailable", "retryable": False,
            "recoverable": True, "read": False}
