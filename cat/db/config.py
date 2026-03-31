"""Database configuration for CAT."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class DatabaseSettings:
    storage_backend: str = "file"
    user: str = ""
    password: str = ""
    dsn: str = ""
    wallet_dir: str = ""
    auto_bootstrap: bool = False


def _parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}



def get_database_settings() -> DatabaseSettings:
    return DatabaseSettings(
        storage_backend=os.getenv("CAT_STORAGE_BACKEND", "file").strip().lower(),
        user=os.getenv("CAT_DB_USER", "").strip(),
        password=os.getenv("CAT_DB_PASSWORD", "").strip(),
        dsn=os.getenv("CAT_DB_DSN", "").strip(),
        wallet_dir=os.getenv("CAT_DB_WALLET_DIR", "").strip(),
        auto_bootstrap=_parse_bool_env("CAT_DB_AUTO_BOOTSTRAP", default=False),
    )



def is_oracle_backend_enabled() -> bool:
    return get_database_settings().storage_backend == "oracle"



def validate_oracle_settings(settings: DatabaseSettings) -> None:
    missing = []
    if not settings.user:
        missing.append("CAT_DB_USER")
    if not settings.password:
        missing.append("CAT_DB_PASSWORD")
    if not settings.dsn:
        missing.append("CAT_DB_DSN")

    if missing:
        raise ValueError(f"Missing required Oracle settings: {', '.join(missing)}")
