import pytest
from app import retrieval

from .test_app import API


def setup_embedding(client, mock_server):
    response = client.put(
        API + "/settings/embedding",
        json={
            "enabled": True,
            "url": mock_server,
            "model": "synthetic-embedding",
            "api_key": "synthetic-embedding-key",
        },
    )
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_semantic_synonyms_index_revisions_and_deletions(client, mock_server):
    memory = client.post(API + "/memories", json={"content": "偏好精炼答复"}).json()
    setup_embedding(client, mock_server)
    await retrieval.index_once()
    assert retrieval.status()["indexed"] == 1
    assert (await retrieval.retrieve("希望言简意赅"))[0]["id"] == memory["id"]
    client.put(f"{API}/memories/{memory['id']}", json={"content": "我在学习Python编程"})
    assert retrieval.status()["indexed"] == 0
    assert not await retrieval.retrieve("希望言简意赅")
    await retrieval.index_once()
    assert (await retrieval.retrieve("编程"))[0]["id"] == memory["id"]
    client.delete(f"{API}/memories/{memory['id']}")
    assert not await retrieval.retrieve("编程")


@pytest.mark.asyncio
async def test_candidates_configuration_changes_and_network_fallback(
    client, mock_server, monkeypatch
):
    client.post(
        API + "/memories", json={"content": "喜欢简短回答", "state": "candidate"}
    )
    saved = client.post(
        API + "/memories", json={"content": "我在学习Python编程"}
    ).json()
    setup_embedding(client, mock_server)
    await retrieval.index_once()
    assert retrieval.status()["total"] == 1

    class Broken:
        async def aembed_query(self, _):
            raise RuntimeError("synthetic credential must never appear")

    monkeypatch.setattr(retrieval, "client", lambda value: Broken())
    assert (await retrieval.retrieve("Python编程"))[0]["id"] == saved["id"]
    assert "synthetic" not in retrieval.status()["error"]
    client.put(
        API + "/settings/embedding",
        json={"enabled": True, "url": mock_server, "model": "different"},
    )
    assert retrieval.status()["indexed"] == 0


@pytest.mark.asyncio
async def test_inflight_semantic_query_cannot_resurrect_deleted_memory(
    client, mock_server, monkeypatch
):
    saved = client.post(API + "/memories", json={"content": "偏好精炼答复"}).json()
    setup_embedding(client, mock_server)
    await retrieval.index_once()

    class DeleteDuringQuery:
        async def aembed_query(self, _):
            client.delete(f"{API}/memories/{saved['id']}")
            return [1.0, 0.0, 0.0]

    monkeypatch.setattr(retrieval, "client", lambda value: DeleteDuringQuery())
    assert not await retrieval.retrieve("言简意赅")


def test_embedding_configuration_secrets_validation_and_test(client, mock_server):
    assert (
        client.get(
            API + "/settings/embedding", headers={"Authorization": ""}
        ).status_code
        == 401
    )
    assert (
        client.put(
            API + "/settings/embedding", json={"enabled": True, "model": "test"}
        ).status_code
        == 400
    )
    assert (
        client.put(
            API + "/settings/embedding",
            json={"url": "https://user:secret@example.com/v1"},
        ).status_code
        == 422
    )
    setup_embedding(client, mock_server)
    status = client.get(API + "/settings/embedding")
    assert "synthetic-embedding-key" not in status.text
    assert status.json()["key_configured"]
    assert client.post(API + "/settings/embedding/test").json() == {
        "ok": True,
        "dimensions": 3,
    }
    client.put(
        API + "/settings/embedding",
        json={"enabled": False, "url": mock_server, "model": "", "api_key": ""},
    )
    assert not client.get(API + "/settings/embedding").json()["key_configured"]


def test_preview_explains_candidates_and_creates_no_chat(client):
    saved = client.post(API + "/memories", json={"content": "偏好精炼答复"}).json()
    client.post(
        API + "/memories", json={"content": "待确认的精炼偏好", "state": "candidate"}
    )
    response = client.post(API + "/memories/retrieval/preview", json={"query": "精炼"})
    assert response.status_code == 200, response.text
    trace = response.json()
    assert trace["mode"] == "keyword" and trace["selected_ids"] == [saved["id"]]
    candidate = trace["candidates"][0]
    assert candidate["selected"] and candidate["keyword_score"] > 0
    assert (
        candidate["semantic_score"] is None
        and candidate["revision"] == saved["revision"]
    )
    assert trace["token_budget"] == 1500 and trace["tokens_used"] > 0
    assert client.get(API + "/runs").json() == []
    assert (
        client.post(
            API + "/memories/retrieval/preview", json={"query": " "}
        ).status_code
        == 400
    )
    assert (
        client.post(
            API + "/memories/retrieval/preview",
            json={"query": "test"},
            headers={"Authorization": ""},
        ).status_code
        == 401
    )


@pytest.mark.asyncio
async def test_trace_includes_semantic_scores_and_excluded_candidates(
    client, mock_server
):
    expected = client.post(API + "/memories", json={"content": "偏好精炼答复"}).json()
    excluded = client.post(
        API + "/memories", json={"content": "正在学习Python编程"}
    ).json()
    setup_embedding(client, mock_server)
    await retrieval.index_once()
    trace = client.post(
        API + "/memories/retrieval/preview", json={"query": "言简意赅"}
    ).json()
    assert trace["mode"] == "hybrid" and trace["selected_ids"] == [expected["id"]]
    by_id = {x["id"]: x for x in trace["candidates"]}
    assert by_id[expected["id"]]["semantic_score"] == 1
    assert by_id[excluded["id"]]["reason"] == "未达到语义阈值"


def test_chat_trace_is_a_snapshot_and_requires_auth(configured):
    from .test_app import wait_run

    saved = configured.post(API + "/memories", json={"content": "偏好简短回答"}).json()
    conversation = configured.post(API + "/conversations", json={}).json()["id"]
    result = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation}/messages",
            json={"content": "我喜欢什么样的简短回答？"},
        ),
    )
    assert result["status"] == "completed", result
    path = f"{API}/runs/{result['id']}/retrieval"
    before = configured.get(path).json()
    assert before[0]["purpose"] == "context" and before[0]["selected_ids"] == [
        saved["id"]
    ]
    configured.put(f"{API}/memories/{saved['id']}", json={"content": "新偏好"})
    assert configured.get(path).json() == before
    assert configured.get(path, headers={"Authorization": ""}).status_code == 401
