"""Shared normalized SQLite database for competitive intelligence ads."""

from __future__ import annotations

import csv
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import urlparse

from app_config import DEFAULT_DB_PATH


VALID_SOURCES = {"foreplay", "adplexity", "meta"}
VALID_STATUSES = {"active", "inactive"}


@dataclass(slots=True)
class NormalizedAd:
    source: str
    source_id: str
    brand: str = ""
    title: str = ""
    ad_copy: str = ""
    first_seen: str | None = None
    last_seen: str | None = None
    days_running: int | None = None
    status: str = "active"
    countries: list[str] | None = None
    platforms: list[str] | None = None
    cta: str = ""
    video_url: str | None = None
    image_url: str | None = None
    landing_page_url: str | None = None
    ad_library_url: str | None = None
    vertical: str | None = None
    fetched_at: str | None = None

    def to_record(self) -> dict[str, Any]:
        record = {
            "source": normalize_source(self.source),
            "source_id": str(self.source_id).strip(),
            "brand": (self.brand or "").strip(),
            "title": (self.title or "").strip(),
            "ad_copy": (self.ad_copy or "").strip(),
            "first_seen": normalize_datetime(self.first_seen),
            "last_seen": normalize_datetime(self.last_seen),
            "days_running": normalize_days_running(
                self.days_running,
                first_seen=self.first_seen,
                last_seen=self.last_seen,
            ),
            "status": normalize_status(self.status),
            "countries": json.dumps(normalize_country_list(self.countries), ensure_ascii=False),
            "platforms": json.dumps(normalize_platform_list(self.platforms), ensure_ascii=False),
            "cta": (self.cta or "").strip(),
            "video_url": normalize_optional_text(self.video_url),
            "image_url": normalize_optional_text(self.image_url),
            "landing_page_url": normalize_optional_text(self.landing_page_url),
            "ad_library_url": normalize_optional_text(self.ad_library_url),
            "vertical": normalize_optional_text(self.vertical),
            "fetched_at": normalize_datetime(self.fetched_at) or now_iso(),
        }
        if not record["source_id"]:
            raise ValueError("source_id is required")
        return record


class IntelligenceDatabase:
    def __init__(self, path: str | Path = DEFAULT_DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def initialize(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ads (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                source            TEXT NOT NULL CHECK (source IN ('foreplay', 'adplexity', 'meta')),
                source_id         TEXT NOT NULL,
                brand             TEXT DEFAULT '',
                title             TEXT DEFAULT '',
                ad_copy           TEXT DEFAULT '',
                first_seen        TEXT,
                last_seen         TEXT,
                days_running      INTEGER,
                status            TEXT NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'inactive')),
                countries         TEXT NOT NULL DEFAULT '[]',
                platforms         TEXT NOT NULL DEFAULT '[]',
                cta               TEXT DEFAULT '',
                video_url         TEXT,
                image_url         TEXT,
                landing_page_url  TEXT,
                ad_library_url    TEXT,
                vertical          TEXT DEFAULT NULL,
                fetched_at        TEXT NOT NULL,
                UNIQUE(source, source_id)
            );

            CREATE INDEX IF NOT EXISTS idx_ads_source
                ON ads(source);
            CREATE INDEX IF NOT EXISTS idx_ads_brand
                ON ads(brand);
            CREATE INDEX IF NOT EXISTS idx_ads_vertical
                ON ads(vertical);
            CREATE INDEX IF NOT EXISTS idx_ads_status
                ON ads(status);
            CREATE INDEX IF NOT EXISTS idx_ads_filters
                ON ads(source, vertical, status);
            CREATE INDEX IF NOT EXISTS idx_ads_first_seen
                ON ads(first_seen);
            CREATE INDEX IF NOT EXISTS idx_ads_days_running
                ON ads(days_running);
            """
        )
        self.conn.commit()

    def upsert_ad(self, ad: NormalizedAd | dict[str, Any]) -> None:
        record = ad.to_record() if isinstance(ad, NormalizedAd) else _dict_to_record(ad)
        self.conn.execute(
            """
            INSERT INTO ads (
                source, source_id, brand, title, ad_copy, first_seen, last_seen,
                days_running, status, countries, platforms, cta, video_url, image_url,
                landing_page_url, ad_library_url, vertical, fetched_at
            ) VALUES (
                :source, :source_id, :brand, :title, :ad_copy, :first_seen, :last_seen,
                :days_running, :status, :countries, :platforms, :cta, :video_url, :image_url,
                :landing_page_url, :ad_library_url, :vertical, :fetched_at
            )
            ON CONFLICT(source, source_id) DO UPDATE SET
                brand             = excluded.brand,
                title             = excluded.title,
                ad_copy           = excluded.ad_copy,
                first_seen        = excluded.first_seen,
                last_seen         = excluded.last_seen,
                days_running      = excluded.days_running,
                status            = excluded.status,
                countries         = excluded.countries,
                platforms         = excluded.platforms,
                cta               = excluded.cta,
                video_url         = excluded.video_url,
                image_url         = excluded.image_url,
                landing_page_url  = excluded.landing_page_url,
                ad_library_url    = excluded.ad_library_url,
                vertical          = COALESCE(ads.vertical, excluded.vertical),
                fetched_at        = excluded.fetched_at
            """,
            record,
        )

    def upsert_ads(self, ads: Iterable[NormalizedAd | dict[str, Any]]) -> int:
        count = 0
        for ad in ads:
            self.upsert_ad(ad)
            count += 1
        self.conn.commit()
        return count

    def get_ads(
        self,
        *,
        source: str | None = None,
        vertical: str | None = None,
        status: str | None = None,
        brand: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []

        if source and source != "all":
            clauses.append("source = ?")
            params.append(normalize_source(source))
        if vertical and vertical != "all":
            if vertical == "unclassified":
                clauses.append("(vertical IS NULL OR vertical = '')")
            else:
                clauses.append("vertical = ?")
                params.append(vertical)
        if status and status != "all":
            clauses.append("status = ?")
            params.append(normalize_status(status))
        if brand:
            clauses.append("brand LIKE ?")
            params.append(f"%{brand.strip()}%")

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"""
            SELECT *
            FROM ads
            {where}
            ORDER BY
                COALESCE(days_running, -1) DESC,
                COALESCE(first_seen, '') DESC,
                source,
                brand
        """
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)

        rows = self.conn.execute(sql, params).fetchall()
        return [self._decode_row(row) for row in rows]

    def get_unclassified_ads(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = """
            SELECT *
            FROM ads
            WHERE vertical IS NULL OR vertical = ''
            ORDER BY COALESCE(days_running, -1) DESC, fetched_at DESC
        """
        params: list[Any] = []
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        return [self._decode_row(row) for row in rows]

    def update_vertical(self, row_id: int, vertical: str | None) -> None:
        self.conn.execute(
            "UPDATE ads SET vertical = ? WHERE id = ?",
            (normalize_optional_text(vertical), row_id),
        )

    def bulk_update_vertical(self, updates: Sequence[tuple[int, str | None]]) -> int:
        for row_id, vertical in updates:
            self.update_vertical(row_id, vertical)
        self.conn.commit()
        return len(updates)

    def get_stats(self) -> dict[str, Any]:
        rows = self.conn.execute(
            """
            SELECT source, status, COALESCE(vertical, 'unclassified') AS vertical, COUNT(*) AS count
            FROM ads
            GROUP BY source, status, COALESCE(vertical, 'unclassified')
            """
        ).fetchall()
        total = self.conn.execute("SELECT COUNT(*) FROM ads").fetchone()[0]
        by_source: dict[str, int] = {}
        by_status: dict[str, int] = {}
        by_vertical: dict[str, int] = {}

        for row in rows:
            by_source[row["source"]] = by_source.get(row["source"], 0) + row["count"]
            by_status[row["status"]] = by_status.get(row["status"], 0) + row["count"]
            by_vertical[row["vertical"]] = by_vertical.get(row["vertical"], 0) + row["count"]

        return {
            "total_ads": total,
            "by_source": by_source,
            "by_status": by_status,
            "by_vertical": by_vertical,
        }

    def export_csv(
        self,
        out_path: str | Path,
        *,
        source: str | None = None,
        vertical: str | None = None,
        status: str | None = None,
        brand: str | None = None,
        limit: int | None = None,
    ) -> Path:
        rows = self.get_ads(
            source=source,
            vertical=vertical,
            status=status,
            brand=brand,
            limit=limit,
        )
        out = Path(out_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "id",
                    "source",
                    "source_id",
                    "brand",
                    "title",
                    "ad_copy",
                    "first_seen",
                    "last_seen",
                    "days_running",
                    "status",
                    "countries",
                    "platforms",
                    "cta",
                    "video_url",
                    "image_url",
                    "landing_page_url",
                    "ad_library_url",
                    "vertical",
                    "fetched_at",
                ],
            )
            writer.writeheader()
            writer.writerows(rows)
        return out

    def close(self) -> None:
        self.conn.close()

    def _decode_row(self, row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["countries"] = parse_json_list(item["countries"])
        item["platforms"] = parse_json_list(item["platforms"])
        item["brand"] = item["brand"] or ""
        item["title"] = item["title"] or ""
        item["ad_copy"] = item["ad_copy"] or ""
        item["cta"] = item["cta"] or ""
        item["vertical"] = item["vertical"] or None
        item["display_vertical"] = item["vertical"] or "unclassified"
        item["display_brand"] = item["brand"] or display_brand_from_url(item["landing_page_url"])
        item["is_winner"] = item["source"] == "foreplay"
        item["winner_label"] = "Winner" if item["is_winner"] else None
        return item


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_source(value: str) -> str:
    source = (value or "").strip().lower()
    if source not in VALID_SOURCES:
        raise ValueError(f"Unsupported source: {value!r}")
    return source


def normalize_status(value: str | bool | int | None) -> str:
    if isinstance(value, bool):
        return "active" if value else "inactive"
    if isinstance(value, int):
        return "active" if value else "inactive"
    text = (str(value or "")).strip().lower()
    if text in {"active", "running", "live", "1", "true"}:
        return "active"
    if text in {"inactive", "ended", "stopped", "0", "false"}:
        return "inactive"
    return "active"


def normalize_optional_text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def normalize_datetime(value: Any) -> str | None:
    if value in (None, "", 0):
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if isinstance(value, (int, float)):
        raw = int(value)
        if raw > 1_000_000_000_000:
            dt = datetime.fromtimestamp(raw / 1000, tz=timezone.utc)
        elif raw > 1_000_000_000:
            dt = datetime.fromtimestamp(raw, tz=timezone.utc)
        else:
            return None
        return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

    text = str(value).strip()
    if not text:
        return None

    if text.isdigit():
        return normalize_datetime(int(text))

    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            parsed = datetime.strptime(text, fmt)
            parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.isoformat().replace("+00:00", "Z")
        except ValueError:
            continue

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_days_running(
    days: Any,
    *,
    first_seen: Any = None,
    last_seen: Any = None,
) -> int | None:
    if days is not None and str(days).strip() != "":
        try:
            return int(days)
        except (TypeError, ValueError):
            pass

    first_iso = normalize_datetime(first_seen)
    last_iso = normalize_datetime(last_seen) or now_iso()
    if not first_iso:
        return None

    first_dt = datetime.fromisoformat(first_iso.replace("Z", "+00:00"))
    last_dt = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
    delta = last_dt - first_dt
    return max(delta.days, 0)


def normalize_country_list(value: Any) -> list[str]:
    items = _coerce_list(value)
    normalized: list[str] = []
    for item in items:
        token = str(item).strip().upper()
        if token and token not in normalized:
            normalized.append(token)
    return normalized


def normalize_platform_list(value: Any) -> list[str]:
    items = _coerce_list(value)
    normalized: list[str] = []
    for item in items:
        token = str(item).strip().lower().replace("-", " ").replace("/", " ")
        token = "_".join(part for part in token.split() if part)
        if token and token not in normalized:
            normalized.append(token)
    return normalized


def parse_json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(parsed, list):
        return [str(item) for item in parsed if str(item).strip()]
    return [str(parsed)]


def display_brand_from_url(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    parts = host.split(".")
    core = parts[-2] if len(parts) >= 2 else parts[0]
    return core.replace("-", " ").replace("_", " ").title()


def _coerce_list(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, list):
                return parsed
        return [part.strip() for part in text.split(",") if part.strip()]
    return [value]


def _dict_to_record(ad: dict[str, Any]) -> dict[str, Any]:
    return NormalizedAd(
        source=ad["source"],
        source_id=str(ad["source_id"]),
        brand=ad.get("brand", ""),
        title=ad.get("title", ""),
        ad_copy=ad.get("ad_copy", ""),
        first_seen=ad.get("first_seen"),
        last_seen=ad.get("last_seen"),
        days_running=ad.get("days_running"),
        status=ad.get("status", "active"),
        countries=ad.get("countries"),
        platforms=ad.get("platforms"),
        cta=ad.get("cta", ""),
        video_url=ad.get("video_url"),
        image_url=ad.get("image_url"),
        landing_page_url=ad.get("landing_page_url"),
        ad_library_url=ad.get("ad_library_url"),
        vertical=ad.get("vertical"),
        fetched_at=ad.get("fetched_at"),
    ).to_record()
