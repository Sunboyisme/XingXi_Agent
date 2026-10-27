from pathlib import Path

import keyring
import keyring.errors

from app import config
from app.config import secret_get as real_secret_get, secret_set as real_secret_set


def fake_keyring(monkeypatch):
    store: dict[tuple[str, str], str] = {}

    def delete(service, name):
        if (service, name) not in store:
            raise keyring.errors.PasswordDeleteError(name)
        del store[(service, name)]

    monkeypatch.setattr(keyring, "get_password", lambda service, name: store.get((service, name)))
    monkeypatch.setattr(keyring, "set_password", lambda service, name, value: store.__setitem__((service, name), value))
    monkeypatch.setattr(keyring, "delete_password", delete)
    monkeypatch.delenv("BAI_DEMO_API_KEY", raising=False)
    return store


def test_only_the_installed_data_directory_reads_legacy_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "preview-runtime").resolve())
    assert config.legacy_vault_services() == []
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "XiaoXi_Agent").resolve())
    assert len(config.legacy_vault_services()) == 1


def test_isolated_directory_does_not_copy_personal_credentials(monkeypatch, tmp_path):
    store = fake_keyring(monkeypatch)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    installed = (tmp_path / "XiaoXi_Agent").resolve()
    monkeypatch.setattr(config, "DATA_DIR", installed)
    (legacy,) = config.legacy_vault_services()
    store[(legacy, "demo")] = "personal-key"
    monkeypatch.setattr(config, "DATA_DIR", Path(tmp_path / "preview").resolve())
    monkeypatch.setattr(config, "VAULT_SERVICE", "BaiAgent-preview")
    assert real_secret_get("demo") == ""
    assert ("BaiAgent-preview", "demo") not in store


def test_clearing_a_migrated_credential_does_not_restore_it(monkeypatch, tmp_path):
    store = fake_keyring(monkeypatch)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "XiaoXi_Agent").resolve())
    monkeypatch.setattr(config, "VAULT_SERVICE", "BaiAgent-installed")
    (legacy,) = config.legacy_vault_services()
    store[(legacy, "demo")] = "old-key"
    assert real_secret_get("demo") == "old-key"
    real_secret_set("demo", "")
    assert real_secret_get("demo") == ""
    assert store == {}
