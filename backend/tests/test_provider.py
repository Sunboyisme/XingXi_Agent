import pytest
import httpx
from langchain_core.messages import AIMessage
from langgraph.errors import GraphRecursionError
from app import provider, search, schemas, db


@pytest.mark.asyncio
async def test_invalid_json_repaired_once_and_never_saved(monkeypatch):
    class Model:
        calls = 0

        async def ainvoke(self, messages):
            self.calls += 1
            return AIMessage(
                content="not JSON"
                if self.calls == 1
                else '{"content":"解释", "exercise":"练习", "hints":[], "criteria":"标准"}'
            )

    model = Model()
    monkeypatch.setattr(provider, "model", lambda: model)
    value = await provider.ask_json(schemas.LessonContent, "test", "test")
    assert model.calls == 2 and value.content == "解释"
    with db.Session() as session:
        assert session.query(db.Lesson).count() == 0


@pytest.mark.asyncio
async def test_invalid_json_fails_after_one_repair(monkeypatch):
    class Model:
        calls = 0

        async def ainvoke(self, messages):
            self.calls += 1
            return AIMessage(content="{}")

    model = Model()
    monkeypatch.setattr(provider, "model", lambda: model)
    with pytest.raises(ValueError, match="模型返回的结构不符合要求"):
        await provider.ask_json(schemas.LessonContent, "test", "test")
    assert model.calls == 2


@pytest.mark.asyncio
async def test_search_and_extract_keep_source_and_do_not_fake_missing_text(monkeypatch):
    calls = []

    def respond(request):
        calls.append(request.url.path)
        data = (
            {
                "results": [
                    {
                        "title": "Official documentation",
                        "url": "https://example.com/docs",
                        "content": "摘要",
                    }
                ]
            }
            if request.url.path == "/search"
            else {"results": []}
        )
        return httpx.Response(200, json=data)

    original = httpx.AsyncClient
    monkeypatch.setattr(search, "secret_get", lambda _: "synthetic-search-key")
    monkeypatch.setattr(
        search.httpx,
        "AsyncClient",
        lambda **_: original(transport=httpx.MockTransport(respond)),
    )
    results = await search.search_web("query")
    assert results["results"][0]["url"] == "https://example.com/docs"
    assert results["results"][0]["summary"] == "摘要"
    extracted = await search.read_webpage("https://example.com/docs")
    assert "content" not in extracted and "未获得正文" in extracted["error"]
    assert calls == ["/search", "/extract"]


@pytest.mark.asyncio
async def test_search_without_key_reports_unavailable(monkeypatch):
    monkeypatch.setattr(search, "secret_get", lambda _: "")
    with pytest.raises(provider.ConfigurationError, match="无法联网查证"):
        await search.search_web("latest news")


@pytest.mark.parametrize(
    "url",
    [
        "file:///C:/file",
        "http://localhost",
        "http://127.0.0.1",
        "http://10.0.0.1",
        "http://[::1]",
        "https://user:pass@example.com",
    ],
)
def test_extract_rejects_non_public_urls(url):
    with pytest.raises(ValueError):
        search.public_url(url)


def test_provider_errors_never_expose_arbitrary_exception_text():
    assert "sk-private-test" not in provider.safe_error(
        ValueError("invalid header sk-private-test")
    )
    assert "sk-private-test" not in provider.safe_error(
        RuntimeError("request with sk-private-test")
    )


def test_graph_limit_is_reported_as_local_limit_not_provider_rate_limit():
    error = GraphRecursionError("synthetic graph limit")
    assert provider.error_details(error)["category"] == "tool_loop_limit"
    message = provider.safe_error(error)
    assert "步数上限" in message and "限流" not in message


def test_wrapped_request_timeout_is_identified_without_exposing_request():
    error = RuntimeError("private request body")
    error.__cause__ = httpx.ReadTimeout("private endpoint and headers")
    assert provider.error_details(error)["category"] == "request_timeout"
    assert "超时" in provider.safe_error(error)
    assert "private" not in provider.safe_error(error)


@pytest.mark.parametrize("code,category", [("rate_limit_exceeded", "rate_limit"), ("insufficient_quota", "quota")])
def test_provider_429_preserves_safe_status_and_distinguishes_quota(code, category):
    class ProviderError(Exception):
        status_code = 429

    error = ProviderError("private credential and response body")
    error.code = code
    details = provider.error_details(error)
    assert details["category"] == category and details["http_status"] == 429
    assert details["provider_code"] == code
    assert "429" in provider.safe_error(error)
    assert "private" not in str(details) + provider.safe_error(error)
