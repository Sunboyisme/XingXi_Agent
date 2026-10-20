import hashlib
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("BAI_DATA_DIR", ROOT / ".local-data" / "dev")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
ATTACHMENTS_DIR = DATA_DIR / "attachments"
ATTACHMENTS_DIR.mkdir(exist_ok=True)
TOKEN_PATH = DATA_DIR / "auth-token"
if not TOKEN_PATH.exists():
    TOKEN_PATH.write_text(secrets.token_urlsafe(40), encoding="utf-8")
AUTH_TOKEN = TOKEN_PATH.read_text(encoding="utf-8").strip()
DATABASE_URL = os.getenv(
    "BAI_DATABASE_URL", f"sqlite:///{(DATA_DIR / 'bai.sqlite').as_posix()}"
)
VAULT_SERVICE = "BaiAgent-" + hashlib.sha256(str(DATA_DIR).encode()).hexdigest()[:16]
PROFILE_ID = "local"


def legacy_vault_services() -> list[str]:
    """Credential services used before the data directory was renamed.

    Windows credentials are keyed by a hash of the data directory, so moving
    from ``com.qinbai.baiagent`` to ``XiaoXi_Agent`` would otherwise look like
    a fresh install with no API keys. Reads fall back to the old service and
    copy the value forward on first use.
    """
    local = os.getenv("LOCALAPPDATA")
    if not local:
        return []
    legacy = (Path(local) / "com.qinbai.baiagent").resolve()
    if legacy == DATA_DIR:
        return []
    return ["BaiAgent-" + hashlib.sha256(str(legacy).encode()).hexdigest()[:16]]


def frontend_origins() -> list[str]:
    """An explicit alternate loopback origin for isolated desktop QA."""
    from urllib.parse import urlsplit

    origin = os.getenv("BAI_FRONTEND_ORIGIN", "")
    if not origin:
        return []
    value = urlsplit(origin)
    if (
        value.scheme != "http"
        or value.hostname not in {"127.0.0.1", "localhost"}
        or not value.port
        or value.username
        or value.password
        or value.path
        or value.query
        or value.fragment
    ):
        raise ValueError("BAI_FRONTEND_ORIGIN 必须为带端口的本机 HTTP 来源")
    return [origin]


def secret_get(name: str) -> str:
    # Environment overrides are useful for isolated tests and future server deployments.
    override = os.getenv(f"BAI_{name.upper()}_API_KEY")
    if override:
        return override
    import keyring

    value = keyring.get_password(VAULT_SERVICE, name)
    if value:
        return value
    for service in legacy_vault_services():
        value = keyring.get_password(service, name)
        if value:
            try:
                keyring.set_password(VAULT_SERVICE, name, value)
            except Exception:  # noqa: BLE001 - reading must still succeed
                pass
            return value
    return ""


def secret_set(name: str, value: str | None) -> None:
    if value is None:
        return
    import keyring

    if value.strip():
        keyring.set_password(VAULT_SERVICE, name, value.strip())
    else:
        try:
            keyring.delete_password(VAULT_SERVICE, name)
        except keyring.errors.PasswordDeleteError:
            pass
