import weakref

import httpx

from app import usage_cost


async def test_metered_clients_share_one_pool_that_outlives_each_client(monkeypatch):
    opened = []
    seen = []

    def respond(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"ok": True})

    def pool():
        value = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        opened.append(value)
        return value

    monkeypatch.setattr(usage_cost, "_AsyncClient", pool)
    monkeypatch.setattr(usage_cost, "_loop_pools", weakref.WeakKeyDictionary())
    metadata = {"kind": "chat"}
    first = usage_cost.MeteredAsyncClient(usage_metadata=metadata, timeout=5)
    second = usage_cost.MeteredAsyncClient(usage_metadata=metadata, timeout=5)
    assert (await first.get("https://models.example/v1/models")).json() == {"ok": True}
    await first.aclose()
    # A closed per-call client must leave the shared pool usable for others.
    assert (await second.get("https://models.example/v1/models")).status_code == 200
    assert len(opened) == 1 and not opened[0].is_closed
    assert len(seen) == 2
    await usage_cost.close_shared_pool()
    assert opened[0].is_closed


def test_clients_with_their_own_transport_keep_it():
    own = httpx.MockTransport(lambda request: httpx.Response(204))
    client = usage_cost.MeteredAsyncClient(usage_metadata={"kind": "images"}, transport=own)
    assert client._transport is own
    direct = usage_cost.MeteredAsyncClient(usage_metadata={"kind": "images"}, trust_env=False)
    assert not isinstance(direct._transport, usage_cost.SharedPoolTransport)
