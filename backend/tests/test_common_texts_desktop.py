from sqlalchemy import select
from app import db, provider

API = "/api/v1"


def test_saved_text_lifecycle_and_default_category_search(client):
    text = "第一行\n第二行\n第三行\n第四行\n第五行"
    value = client.post(API + "/common-texts", json={"content": text, "category_id": None})
    assert value.status_code == 200
    saved = value.json()
    assert saved["content"] == text and saved["category_id"] is None
    assert client.get(API + "/common-texts", params={"q": "默认分类"}).json()[0]["id"] == saved["id"]
    category = client.post(API + "/common-text-categories", json={"name": "工作"}).json()
    assert client.put(API + f"/common-texts/{saved['id']}", json={"content": text, "category_id": category["id"]}).status_code == 200
    assert len(client.get(API + "/common-texts", params={"q": "工作"}).json()) == 1
    assert client.delete(API + f"/common-text-categories/{category['id']}").status_code == 200
    result = client.get(API + "/common-texts", params={"category_id": "uncategorized"}).json()
    assert result[0]["content"] == text and result[0]["category_id"] is None
    assert client.delete(API + f"/common-texts/{saved['id']}").status_code == 200
    assert client.get(API + "/common-texts").json() == []


def test_categories_validate_uniqueness_reserved_names_and_profile_access(client):
    assert client.post(API + "/common-text-categories", json={"name": "默认分类"}).status_code == 422
    assert client.post(API + "/common-text-categories", json={"name": " Work "}).status_code == 200
    assert client.post(API + "/common-text-categories", json={"name": "work"}).status_code == 409
    with db.Session() as session:
        category = db.CommonTextCategory(profile_id="other", name="私有", name_key="私有")
        session.add(category); session.commit(); key = category.id
    assert client.post(API + "/common-texts", json={"content": "测试", "category_id": key}).status_code == 404
    assert client.delete(API + f"/common-text-categories/{key}").status_code == 404
    assert client.post(API + "/common-texts", json={"content": "  \n"}).status_code == 422


def test_desktop_text_actions_stream_without_creating_chat(configured):
    before = configured.get(API + "/conversations").json()
    for action in ("explain", "translate", "summarize"):
        result = configured.post(API + "/desktop/actions", json={"action": action, "text": "春天到了，花开了。"})
        assert result.status_code == 200
        identifier = result.json()["id"]
        stream = configured.get(API + f"/runs/{identifier}/events")
        assert stream.status_code == 200 and '"kind": "delta"' in stream.text
        assert configured.get(API + f"/runs/{identifier}").json()["status"] == "completed"
    assert configured.get(API + "/conversations").json() == before
    with db.Session() as session:
        assert {row.purpose for row in session.scalars(select(db.UsageCall))} >= {"desktop_explain", "desktop_translate", "desktop_summarize"}


def test_desktop_materials_are_exclusive_and_ocr_requires_image(client):
    for body in ({"action": "explain"}, {"action": "ocr", "text": "材料"},
                 {"action": "translate", "text": "材料", "attachment_id": "example"},
                 {"action": "summarize", "attachment_id": "example"}):
        assert client.post(API + "/desktop/actions", json=body).status_code == 422


def test_selection_disables_model_thinking_without_changing_chat_defaults(configured, mock_server, monkeypatch):
    from . import mock_provider
    original_reply = mock_provider.reply
    def reply(body):
        return {**original_reply(body), "reasoning_content": "不应发给划词界面的推理"}
    monkeypatch.setattr(mock_provider, "reply", reply)
    result = configured.put(API + "/settings", json={"providers": [{
        "id": "custom", "model_url": mock_server, "default_model": "mock-test",
        "models": [{"name": "mock-test", "thinking_mode": "thinking", "default_thinking_enabled": True}],
    }]})
    assert result.status_code == 200
    observed = []
    original_model = provider.model
    def model(selected, **options):
        observed.append(selected.copy())
        return original_model(selected, **options)
    monkeypatch.setattr(provider, "model", model)
    for action in ("explain", "translate", "summarize"):
        response = configured.post(API + "/desktop/actions", json={"action": action, "text": "选区材料",
            "model_selection": {"provider_id": "custom", "model_name": "mock-test", "thinking_enabled": True}})
        assert response.status_code == 200
        run_id = response.json()["id"]
        events = configured.get(API + f"/runs/{run_id}/events").text
        assert '"kind": "delta"' in events and '"kind": "reasoning"' not in events
        with db.Session() as session:
            assert session.get(db.Run, run_id).model_config["thinking_enabled"] is False
    assert all(not selection["thinking_enabled"] and selection["reasoning_effort"] is None for selection in observed)
    settings = configured.get(API + "/settings").json()
    assert settings["providers"][0]["models"][0]["default_thinking_enabled"] is True


def test_selection_reports_models_that_cannot_disable_thinking(configured, mock_server):
    result = configured.put(API + "/settings", json={"providers": [{
        "id": "custom", "model_url": mock_server, "default_model": "mock-test",
        "models": [{"name": "mock-test", "thinking_mode": "always"}],
    }]})
    assert result.status_code == 200
    response = configured.post(API + "/desktop/actions", json={"action": "explain", "text": "选区材料"})
    assert response.status_code == 400 and "不支持关闭思考" in response.json()["detail"]
