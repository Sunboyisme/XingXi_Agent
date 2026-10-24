"""Opt-in isolated browser QA. Never reads or writes the real preview profile."""
import os
from pathlib import Path
import threading

folder = Path(os.environ["BAI_DATA_DIR"]).resolve()
if folder.name != "qa018":
    raise RuntimeError("This fixture requires a dedicated qa018 directory")
from tests.mock_provider import Handler, ThreadingHTTPServer
from app import config, db, main, provider, search, tools

for module in (config, main, provider, search, tools):
    module.secret_get = lambda name: "synthetic-key" if name == "model" else ""
    module.secret_set = lambda *_: None

db.migrate()
with db.Session() as session:
    settings = session.get(db.Settings, config.PROFILE_ID)
    settings.model_url = "http://127.0.0.1:8792/v1"
    settings.model_name = "mock-test"
    settings.vision_enabled = True
    session.commit()
server = ThreadingHTTPServer(("127.0.0.1", 8792), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
import uvicorn
uvicorn.run(main.app, host="127.0.0.1", port=8791)
