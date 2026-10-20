import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
import pytest

# Set before importing the application. Tests never open the personal development DB.
os.environ["BAI_DATA_DIR"] = tempfile.mkdtemp(prefix="bai-agent-tests-")
os.environ.pop("BAI_DATABASE_URL", None)
from app import db, config, provider, main, search, tools
from fastapi.testclient import TestClient
from .mock_provider import Handler, ThreadingHTTPServer


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    db.migrate()
    with db.Session() as session:
        for table in reversed(db.Base.metadata.sorted_tables):
            session.execute(table.delete())
        session.add(db.Settings(id=config.PROFILE_ID))
        session.commit()
    vault = {}

    def get(name):
        return vault.get(name, "")

    def put(name, value):
        if value is not None:
            vault[name] = value

    monkeypatch.setattr(provider, "secret_get", get)
    monkeypatch.setattr(main, "secret_get", get)
    monkeypatch.setattr(main, "secret_set", put)
    monkeypatch.setattr(search, "secret_get", get)
    monkeypatch.setattr(tools, "secret_get", get)
    monkeypatch.setattr(config, "secret_get", get)
    monkeypatch.setattr(config, "secret_set", put)
    yield vault


@pytest.fixture
def client():
    with TestClient(main.app) as value:
        value.headers["Authorization"] = "Bearer " + config.AUTH_TOKEN
        yield value


@pytest.fixture(scope="session")
def mock_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/v1"
    server.shutdown()
    server.server_close()


@pytest.fixture
def http_mcp_url():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    fixture = str(Path(__file__).with_name("mcp_fixture.py"))
    process = subprocess.Popen(
        [sys.executable, fixture, "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                if process.poll() is not None:
                    pytest.fail("HTTP MCP fixture exited")
                time.sleep(0.1)
        else:
            pytest.fail("HTTP MCP fixture did not start")
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        process.terminate()
        process.wait(timeout=10)


@pytest.fixture
def configured(client, mock_server):
    response = client.put(
        "/api/v1/settings",
        json={
            "model_url": mock_server,
            "model_name": "mock-test",
            "model_key": "synthetic-key",
            "vision_enabled": True,
        },
    )
    assert response.status_code == 200
    return client
