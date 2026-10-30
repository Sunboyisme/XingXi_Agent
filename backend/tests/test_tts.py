import asyncio
import io
import json
import wave

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import config, db, tts

API = "/api/v1"


def audio_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 1600)
    return output.getvalue()


def test_presets_keys_and_asr_configuration_are_independent(client, isolate):
    before = client.get(API + "/settings/speech").json()
    values = client.get(API + "/settings/tts").json()
    assert values["selected"] == "bailian"
    assert [p["provider"] for p in values["presets"]] == ["bailian", "siliconflow", "minimax", "custom"]
    profile = values["profiles"][0]
    response = client.put(API + "/settings/tts", json={"selected": "bailian", "profiles": [{**profile, "api_key": "synthetic-tts-key"}]})
    assert response.status_code == 200 and "synthetic-tts-key" not in response.text
    assert response.json()["profiles"][0]["key_configured"] is True
    assert isolate["tts:bailian"] == "synthetic-tts-key"
    assert client.get(API + "/settings/speech").json() == before
    assert client.put(API + "/settings/tts", json={"selected": "bailian", "profiles": [profile]}).status_code == 200
    assert isolate["tts:bailian"] == "synthetic-tts-key"
    assert client.put(API + "/settings/tts", json={"selected": "bailian", "profiles": [{**profile, "api_key": ""}]}).json()["profiles"][0]["key_configured"] is False
    with db.Session() as session:
        assert "synthetic-tts-key" not in json.dumps(session.get(db.Settings, config.PROFILE_ID).tts_config)


@pytest.mark.parametrize("provider", ["bailian", "siliconflow", "minimax", "custom"])
def test_provider_protocols_return_ephemeral_audio_without_runs(client, monkeypatch, provider):
    audio = audio_bytes()
    requests = []
    def handler(request):
        requests.append(request)
        if request.method == "GET":
            assert "authorization" not in request.headers
            assert request.url.scheme == "https"
            return httpx.Response(200, content=audio)
        body = json.loads(request.content)
        assert request.headers["Authorization"] == "Bearer synthetic-tts-key"
        if provider == "bailian":
            assert request.url.path.endswith(tts.ALI_PATH)
            assert body["input"] == {"text": "朗读材料", "voice": "voice-id", "language_type": "Auto"}
            return httpx.Response(200, json={"output": {"audio": {"url": "http://test.oss-cn-beijing.aliyuncs.com/audio.wav?signature=sample"}}})
        if provider == "minimax":
            assert request.url.path == "/v1/t2a_v2"
            assert body["voice_setting"]["voice_id"] == "voice-id" and body["stream"] is False
            return httpx.Response(200, json={"base_resp": {"status_code": 0}, "data": {"audio": audio.hex()}})
        assert request.url.path == "/v1/audio/speech"
        assert body["input"] == "朗读材料" and body["voice"] == "voice-id"
        return httpx.Response(200, content=audio)
    original_client = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    response = client.post(API + "/speech/synthesis", json={"text": "朗读材料", "profile": {
        "provider": provider, "url": "https://example.com/v1", "model": "tts-test", "voice": "voice-id", "api_key": "synthetic-tts-key",
    }})
    assert response.status_code == 200
    assert response.content == audio and response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert len(requests) == (2 if provider == "bailian" else 1)
    with db.Session() as session:
        assert list(session.scalars(select(db.Run))) == []
        assert session.get(db.Settings, config.PROFILE_ID).tts_config == {}


def test_invalid_inputs_and_unconfigured_service_fail_before_network(client):
    assert client.post(API + "/speech/synthesis", json={"text": "朗读"}).status_code == 400
    for text in ("  ", "字" * 601):
        assert client.post(API + "/speech/synthesis", json={"text": text}).status_code == 422
    value = {"provider": "custom", "url": "https://user:secret@example.com/v1", "model": "tts", "voice": "voice"}
    assert client.put(API + "/settings/tts", json={"selected": "custom", "profiles": [value]}).status_code == 422


@pytest.mark.asyncio
async def test_disconnect_cancels_the_upstream_synthesis(monkeypatch):
    cancelled = asyncio.Event()
    async def slow(_value):
        try: await asyncio.Event().wait()
        finally: cancelled.set()
    class Disconnected:
        async def receive(self): return {"type": "http.disconnect"}
    monkeypatch.setattr(tts, "synthesize", slow)
    with pytest.raises(HTTPException) as error:
        await tts.speech(tts.TTSSynthesisWrite(text="取消检查"), Disconnected())
    assert error.value.status_code == 499 and cancelled.is_set()
