"""Shared configuration for the unified competitive intelligence app."""

from __future__ import annotations

import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"' ")
        if key and key not in os.environ:
            os.environ[key] = value


def _env_text(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        return int(raw)
    except ValueError:
        return default


def _env_path(name: str, default: Path) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (ROOT_DIR / candidate).resolve()
    return candidate


_load_env_file(ROOT_DIR / ".env")

DB_DIR = ROOT_DIR / "db"
DEFAULT_DB_PATH = _env_path("INTELLIGENCE_DB_PATH", DB_DIR / "intelligence.db")
DEFAULT_DASHBOARD_PATH = _env_path("INTELLIGENCE_DASHBOARD_PATH", DB_DIR / "intelligence_dashboard.html")
DEFAULT_DASHBOARD_SETTINGS_PATH = _env_path("INTELLIGENCE_DASHBOARD_SETTINGS_PATH", DB_DIR / "dashboard_settings.json")
DEFAULT_DASHBOARD_PORT = _env_int("INTELLIGENCE_DASHBOARD_PORT", 8050)

FOREPLAY_EMAIL = _env_text("FOREPLAY_EMAIL")
FOREPLAY_PASSWORD = _env_text("FOREPLAY_PASSWORD")

ADPLEXITY_EMAIL = _env_text("ADPLEXITY_EMAIL")
ADPLEXITY_PASSWORD = _env_text("ADPLEXITY_PASSWORD")

META_SOURCE_DIR = _env_path("META_SOURCE_DIR", ROOT_DIR / "sources" / "meta")
META_ADVERTISERS_DB = _env_path("META_ADVERTISERS_DB", META_SOURCE_DIR / "ads.db")
